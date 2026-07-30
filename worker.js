// =========================================================================
// ArqueoStretch - worker.js
//
// CÓMO FUNCIONA ESTE ARCHIVO
//
// El estiramiento por descorrelación es, para cada píxel, esto:
//
//     salida = M · (entrada - media) + media
//
// donde M es una matriz 3x3 y "media" un vector, ambos calculados a partir
// de las estadísticas de la imagen completa. Es decir: una vez se conocen
// esas constantes, CADA PÍXEL ES INDEPENDIENTE DE LOS DEMÁS.
//
// De esa propiedad salen las dos capacidades de esta versión:
//
//   1. No hace falta guardar la imagen en arrays de float intermedios.
//      Antes se reservaban seis Float32Array del tamaño de la imagen
//      (24 bytes por píxel). Ahora se recorre la imagen leyendo los bytes
//      originales y escribiendo los de salida, sin nada en medio.
//
//   2. La imagen se puede procesar por bandas horizontales, una cada vez,
//      con memoria constante. Eso es lo que permite exportar a resolución
//      completa sin límite práctico de tamaño.
//
// Las constantes se calculan sobre la previsualización y se reutilizan tal
// cual en la exportación. No es un atajo: la matriz de covarianza es una
// estimación estadística, y con dos millones de píxeles de muestra el error
// sobre los autovectores está en el orden del 0,07 %. Reutilizarlas además
// garantiza que el archivo exportado sea exactamente lo que se vio en
// pantalla, que en documentación arqueológica importa más que el decimal.
// =========================================================================

const WORKER_VERSION = "0.6";

// Nº de píxeles de muestra para estimar medias, covarianza y percentiles.
// Por debajo de esta cifra se usan todos.
const STAT_SAMPLE_TARGET = 2000000;

// Píxeles por banda en la exportación. Una banda de 4 Mpx ocupa unos 16 MB
// en RGBA, que cabe holgadamente en cualquier dispositivo.
const STRIP_TARGET_PIXELS = 4000000;

const KNOWN_FILTERS = [
    'yds', 'ybr', 'ybk', 'yre',
    'lab', 'lds', 'lre',
    'crgb', 'pca_rgb', 'yuv_stretch'
];

// Modos de espacio de color. Se resuelven una vez, fuera de los bucles.
const MODE_RGB = 0;   // pca_rgb, crgb y cualquier filtro no reconocido
const MODE_YUV = 1;   // yuv_stretch
const MODE_YXX = 2;   // yds, ybr, ybk, yre
const MODE_LXX = 3;   // lab, lds, lre

// -------------------------------------------------------------------------
// TABLAS DE CONSULTA
//
// Las funciones no lineales (raíz cúbica de CIELAB y codificación sRGB) se
// tabulan porque en una exportación de 100 Mpx se llamarían cientos de
// millones de veces. Con 16384 entradas e interpolación lineal el error
// queda muy por debajo de la mitad de un valor de 8 bits, así que no es
// perceptible ni medible en el archivo final.
// -------------------------------------------------------------------------
const rgb2xyzlut = new Float64Array(256);
for (let i = 0; i < 256; i++) {
    let v = i / 255.0;
    v = (v > 0.04045) ? Math.pow((v + 0.055) / 1.055, 2.4) : (v / 12.92);
    rgb2xyzlut[i] = v * 100.0;
}

const FLAB_N = 16384;
const FLAB_MAX = 1.30;
const flabLut = new Float64Array(FLAB_N + 1);
for (let i = 0; i <= FLAB_N; i++) {
    const t = (i / FLAB_N) * FLAB_MAX;
    flabLut[i] = (t > 0.008856) ? Math.cbrt(t) : (7.787 * t + 0.13793103448275862);
}

function fLab(t) {
    if (t <= 0) return 0.13793103448275862;
    if (t >= FLAB_MAX) return Math.cbrt(t);
    const x = (t / FLAB_MAX) * FLAB_N;
    const i = x | 0;
    const f = x - i;
    return flabLut[i] + (flabLut[i + 1] - flabLut[i]) * f;
}

function fLabInv(t) {
    const t3 = t * t * t;
    return (t3 > 0.008856) ? t3 : ((t - 0.13793103448275862) / 7.787);
}

const SRGB_N = 16384;
const srgbLut = new Float64Array(SRGB_N + 1);
for (let i = 0; i <= SRGB_N; i++) {
    const v = i / SRGB_N;
    srgbLut[i] = (v > 0.0031308) ? (1.055 * Math.pow(v, 0.4166666666666667) - 0.055) : (12.92 * v);
}

function xyz2rgbVal(val) {
    const v = val / 100.0;
    if (v <= 0) return 0;
    if (v >= 1) return 255;
    const x = v * SRGB_N;
    const i = x | 0;
    const f = x - i;
    const enc = srgbLut[i] + (srgbLut[i + 1] - srgbLut[i]) * f;
    // El redondeo y el acotado a [0,255] aquí dentro son deliberados: así
    // se comporta desde la primera versión, y los códigos de configuración
    // y los .json ya exportados tienen que seguir dando el mismo resultado.
    const out = Math.round(enc * 255.0);
    return out < 0 ? 0 : (out > 255 ? 255 : out);
}

// -------------------------------------------------------------------------
// PARÁMETROS DEL ESPACIO DE COLOR
// -------------------------------------------------------------------------
function spaceParams(filter) {
    const p = {
        mode: MODE_RGB,
        ky: 1.0, ku: 0.5, kv: 1.0,
        Lm1: 0.5, Lm2: 0.5, Am: 1.0, Bm: 1.0
    };

    if (filter === 'yuv_stretch') {
        p.mode = MODE_YUV;
    } else if (filter === 'yds' || filter === 'ybr' || filter === 'ybk' || filter === 'yre') {
        p.mode = MODE_YXX;
        if (filter === 'ybr') { p.ky = 1.0; p.ku = 0.8; p.kv = 0.4; }
        else if (filter === 'ybk') { p.ky = 1.5; p.ku = 0.2; p.kv = 1.6; }
        else if (filter === 'yre') { p.ky = 8.0; p.ku = 1.0; p.kv = 0.4; }
    } else if (filter === 'lab' || filter === 'lds' || filter === 'lre') {
        p.mode = MODE_LXX;
        if (filter === 'lds') { p.Am = 0.9; p.Bm = 0.5; }
        else if (filter === 'lre') { p.Am = 0.5; p.Bm = 1.0; }
    }
    return p;
}

// Vectores reutilizables: evitan reservar memoria dentro de los bucles.
const _fwd = new Float64Array(3);
const _inv = new Float64Array(3);

function forwardPixel(p, r, g, b, out) {
    switch (p.mode) {
        case MODE_YUV:
            out[0] = 0.299 * r + 0.587 * g + 0.114 * b;
            out[1] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
            out[2] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
            return;
        case MODE_YXX: {
            const y = 0.299 * r + 0.587 * g + 0.114 * b;
            out[0] = y;
            out[1] = p.ky * (b - p.ku * y);
            out[2] = p.ky * (r - p.kv * y);
            return;
        }
        case MODE_LXX: {
            const rX = rgb2xyzlut[r], gX = rgb2xyzlut[g], bX = rgb2xyzlut[b];
            const X = rX * 0.4124 + gX * 0.3576 + bX * 0.1805;
            const Y = rX * 0.2126 + gX * 0.7152 + bX * 0.0722;
            const Z = rX * 0.0193 + gX * 0.1192 + bX * 0.9505;
            const fX = fLab(X / 95.047);
            const fY = fLab(Y / 100.000);
            const fZ = fLab(Z / 108.883);
            out[0] = 116.0 * fY - 16.0;
            out[1] = (250.0 / p.Lm1) * (fX - p.Am * fY);
            out[2] = (100.0 / p.Lm2) * (p.Bm * fY - fZ);
            return;
        }
        default:
            out[0] = r; out[1] = g; out[2] = b;
    }
}

function inversePixel(p, w1, w2, w3, out) {
    switch (p.mode) {
        case MODE_YUV: {
            const cb = w2 - 128, cr = w3 - 128;
            out[0] = w1 + 1.402 * cr;
            out[1] = w1 - 0.344136 * cb - 0.714136 * cr;
            out[2] = w1 + 1.772 * cb;
            return;
        }
        case MODE_YXX: {
            const r = (w3 / p.ky) + p.kv * w1;
            const b = (w2 / p.ky) + p.ku * w1;
            out[0] = r;
            out[1] = 1.70358 * (w1 - 0.299 * r - 0.114 * b);
            out[2] = b;
            return;
        }
        case MODE_LXX: {
            const fY = (w1 + 16.0) / 116.0;
            const fX = (p.Lm1 * w2 / 250.0) + p.Am * fY;
            const fZ = p.Bm * fY - (p.Lm2 * w3 / 100.0);
            const X = 95.047 * fLabInv(fX);
            const Y = 100.000 * fLabInv(fY);
            const Z = 108.883 * fLabInv(fZ);
            out[0] = xyz2rgbVal((X * 0.032406 + Y * -0.015372 + Z * -0.004986) * 100.0);
            out[1] = xyz2rgbVal((X * -0.009689 + Y * 0.018758 + Z * 0.000415) * 100.0);
            out[2] = xyz2rgbVal((X * 0.000557 + Y * -0.002040 + Z * 0.010570) * 100.0);
            return;
        }
        default:
            out[0] = w1; out[1] = w2; out[2] = w3;
    }
}

// -------------------------------------------------------------------------
// MUESTREO
//
// Rejilla 2D en lugar de un salto lineal: un salto lineal que coincidiera
// con el ancho de la imagen muestrearía siempre la misma columna.
// -------------------------------------------------------------------------
function sampleGrid(w, h, roi) {
    let x0 = 0, y0 = 0, x1 = w, y1 = h;
    if (roi) {
        x0 = Math.max(0, Math.floor(roi.x));
        y0 = Math.max(0, Math.floor(roi.y));
        x1 = Math.min(w, Math.ceil(roi.x + roi.w));
        y1 = Math.min(h, Math.ceil(roi.y + roi.h));
        if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = w; y1 = h; }
    }
    const area = (x1 - x0) * (y1 - y0);
    const step = Math.max(1, Math.ceil(Math.sqrt(area / STAT_SAMPLE_TARGET)));
    return { x0, y0, x1, y1, step, restrictedToRoi: !!roi };
}

/**
 * Recorre los píxeles de muestra. Dentro de una selección se descartan los
 * quemados y los completamente negros: en abrigos con sol duro esas zonas
 * distorsionan la matriz de covarianza y estropean el realce del resto.
 */
function forEachSample(data, w, grid, fn) {
    let count = 0;
    for (let y = grid.y0; y < grid.y1; y += grid.step) {
        const row = y * w;
        for (let x = grid.x0; x < grid.x1; x += grid.step) {
            const idx = (row + x) * 4;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            if (grid.restrictedToRoi) {
                if ((r > 250 && g > 250 && b > 250) || (r < 5 && g < 5 && b < 5)) continue;
            }
            fn(r, g, b);
            count++;
        }
    }
    return count;
}

// -------------------------------------------------------------------------
// CÁLCULO DE LAS CONSTANTES
//
// Devuelve todo lo que hace falta para transformar cualquier píxel de la
// imagen a cualquier resolución: el vector de medias, la matriz 3x3 ya
// compuesta, y los límites del estiramiento final de contraste.
// -------------------------------------------------------------------------
function computeConstants(data, w, h, filter, targetStd, roi) {
    if (!isFinite(targetStd) || targetStd <= 0) {
        throw new Error("El valor de intensidad recibido no es válido.");
    }

    const p = spaceParams(filter);
    let grid = sampleGrid(w, h, roi);

    // --- Medias ---
    let s1 = 0, s2 = 0, s3 = 0;
    let n = forEachSample(data, w, grid, (r, g, b) => {
        forwardPixel(p, r, g, b, _fwd);
        s1 += _fwd[0]; s2 += _fwd[1]; s3 += _fwd[2];
    });

    // Si el descarte de píxeles quemados deja la selección casi vacía, se
    // repite sin filtrar: mejor un cálculo imperfecto que ninguno.
    if (n < 64 && grid.restrictedToRoi) {
        grid = { ...grid, restrictedToRoi: false };
        s1 = s2 = s3 = 0;
        n = forEachSample(data, w, grid, (r, g, b) => {
            forwardPixel(p, r, g, b, _fwd);
            s1 += _fwd[0]; s2 += _fwd[1]; s3 += _fwd[2];
        });
    }

    if (n === 0) throw new Error("No hay píxeles utilizables para calcular el color.");

    const m1 = s1 / n, m2 = s2 / n, m3 = s3 / n;

    // --- Matriz 3x3 ---
    let M;

    if (filter === 'crgb') {
        // Matriz fija de DStretch, sin PCA.
        const k = targetStd / 10.0;
        M = [
            [0.37 * k, 0.34 * k, 0.30 * k],
            [-3.80 * k, 7.70 * k, -4.00 * k],
            [-1.80 * k, 0.22 * k, 2.00 * k]
        ];
    } else {
        let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
        forEachSample(data, w, grid, (r, g, b) => {
            forwardPixel(p, r, g, b, _fwd);
            const v1 = _fwd[0] - m1, v2 = _fwd[1] - m2, v3 = _fwd[2] - m3;
            c00 += v1 * v1; c01 += v1 * v2; c02 += v1 * v3;
            c11 += v2 * v2; c12 += v2 * v3; c22 += v3 * v3;
        });

        const div = Math.max(1, n - 1);
        const cov = [
            [c00 / div, c01 / div, c02 / div],
            [c01 / div, c11 / div, c12 / div],
            [c02 / div, c12 / div, c22 / div]
        ];

        const eigen = jacobiEigenDecomposition(cov);
        const order = [0, 1, 2].sort((a, b) => eigen.values[b] - eigen.values[a]);

        const L = order.map(i => eigen.values[i]);
        const V = [
            [eigen.vectors[0][order[0]], eigen.vectors[0][order[1]], eigen.vectors[0][order[2]]],
            [eigen.vectors[1][order[0]], eigen.vectors[1][order[1]], eigen.vectors[1][order[2]]],
            [eigen.vectors[2][order[0]], eigen.vectors[2][order[1]], eigen.vectors[2][order[2]]]
        ];

        // LRE es muy sensible: DStretch reduce su escala a la mitad.
        const effective = (filter === 'lre') ? targetStd * 0.5 : targetStd;
        const eps = 1e-6;
        const sc = [1.0, 1.0, 1.0];
        for (let i = 0; i < 3; i++) {
            if (!isFinite(L[i])) throw new Error("El cálculo estadístico no convergió con esta imagen.");
            if (L[i] > 1e-4) sc[i] = effective / Math.sqrt(L[i] + eps);
        }

        // M = V · diag(escalas) · Vt, que es rotar al espacio principal,
        // estirar y volver, todo condensado en una sola matriz.
        M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                M[i][j] = V[i][0] * sc[0] * V[j][0]
                        + V[i][1] * sc[1] * V[j][1]
                        + V[i][2] * sc[2] * V[j][2];
            }
        }
    }

    const constants = { filter, mode: p.mode, m: [m1, m2, m3], M, lo: 0, range: 255 };

    // --- Límites del estiramiento final, por percentiles ---
    const bounds = computeStretchBounds(data, w, grid, p, constants);
    constants.lo = bounds.lo;
    constants.range = bounds.range;

    return constants;
}

/**
 * ESTIRAMIENTO ROBUSTO POR PERCENTILES
 *
 * Estirar contra el mínimo y el máximo absolutos es muy vulnerable a dos o
 * tres píxeles atípicos (ruido del sensor, un reflejo, polvo en el
 * objetivo): esos pocos píxeles bastan para aplastar el resto de la imagen
 * en una banda estrecha de grises. Los espacios de ganancia alta (YRE, con
 * ky = 8.0) amplifican también esos atípicos.
 *
 * Se recorta un porcentaje pequeño de las muestras más extremas por cada
 * lado antes de estirar, que es lo que hacen DStretch e ImageJ en su
 * autocontraste.
 */
function computeStretchBounds(data, w, grid, p, k) {
    const m = k.m, M = k.M;

    const transform = (r, g, b, out) => {
        forwardPixel(p, r, g, b, _fwd);
        const v1 = _fwd[0] - m[0], v2 = _fwd[1] - m[1], v3 = _fwd[2] - m[2];
        inversePixel(p,
            M[0][0] * v1 + M[0][1] * v2 + M[0][2] * v3 + m[0],
            M[1][0] * v1 + M[1][1] * v2 + M[1][2] * v3 + m[1],
            M[2][0] * v1 + M[2][1] * v2 + M[2][2] * v3 + m[2],
            out);
        if (!isFinite(out[0])) out[0] = 128;
        if (!isFinite(out[1])) out[1] = 128;
        if (!isFinite(out[2])) out[2] = 128;
    };

    let lo = Infinity, hi = -Infinity;
    forEachSample(data, w, grid, (r, g, b) => {
        transform(r, g, b, _inv);
        for (let c = 0; c < 3; c++) {
            if (_inv[c] < lo) lo = _inv[c];
            if (_inv[c] > hi) hi = _inv[c];
        }
    });

    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-5) {
        return { lo: isFinite(lo) ? lo : 0, range: 1e-5 };
    }

    const NBINS = 2048;
    const bins = new Uint32Array(NBINS);
    const binScale = (NBINS - 1) / (hi - lo);
    let samples = 0;

    forEachSample(data, w, grid, (r, g, b) => {
        transform(r, g, b, _inv);
        for (let c = 0; c < 3; c++) {
            bins[Math.min(NBINS - 1, Math.max(0, Math.round((_inv[c] - lo) * binScale)))]++;
        }
        samples += 3;
    });

    const CLIP_FRACTION = 0.005;
    const clip = Math.floor(samples * CLIP_FRACTION);

    let cum = 0, loBin = 0;
    for (let b = 0; b < NBINS; b++) { cum += bins[b]; if (cum > clip) { loBin = b; break; } }
    cum = 0; let hiBin = NBINS - 1;
    for (let b = NBINS - 1; b >= 0; b--) { cum += bins[b]; if (cum > clip) { hiBin = b; break; } }

    let loValue = lo + loBin / binScale;
    let hiValue = lo + hiBin / binScale;
    if (hiValue <= loValue) { loValue = lo; hiValue = hi; }

    return { lo: loValue, range: Math.max(1e-5, hiValue - loValue) };
}

function jacobiEigenDecomposition(A) {
    const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const M = [[A[0][0], A[0][1], A[0][2]], [A[1][0], A[1][1], A[1][2]], [A[2][0], A[2][1], A[2][2]]];
    const maxIterations = 50, tolerance = 1e-10;

    for (let iter = 0; iter < maxIterations; iter++) {
        let p = 0, q = 1, maxVal = Math.abs(M[0][1]);
        if (Math.abs(M[0][2]) > maxVal) { maxVal = Math.abs(M[0][2]); p = 0; q = 2; }
        if (Math.abs(M[1][2]) > maxVal) { maxVal = Math.abs(M[1][2]); p = 1; q = 2; }
        if (maxVal < tolerance) break;

        const theta = (M[q][q] - M[p][p]) / (2.0 * M[p][q]);
        let t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(1.0 + theta * theta));
        if (theta === 0) t = 1.0;

        const c = 1.0 / Math.sqrt(1.0 + t * t), s = t * c, tau = s / (1.0 + c);
        const m_pp = M[p][p], m_qq = M[q][q], m_pq = M[p][q];

        M[p][p] = m_pp - t * m_pq; M[q][q] = m_qq + t * m_pq;
        M[p][q] = 0.0; M[q][p] = 0.0;

        for (let r = 0; r < 3; r++) {
            if (r !== p && r !== q) {
                const m_rp = M[r][p], m_rq = M[r][q];
                M[r][p] = m_rp - s * (m_rq + m_rp * tau); M[p][r] = M[r][p];
                M[r][q] = m_rq + s * (m_rp - m_rq * tau); M[q][r] = M[r][q];
            }
            const v_rp = V[r][p], v_rq = V[r][q];
            V[r][p] = v_rp - s * (v_rq + v_rp * tau);
            V[r][q] = v_rq + s * (v_rp - v_rq * tau);
        }
    }
    return { values: [M[0][0], M[1][1], M[2][2]], vectors: V };
}

// -------------------------------------------------------------------------
// APLICACIÓN A PÍXELES
//
// srcData es RGBA. dst puede ser RGBA (previsualización) o RGB (PNG).
// Sin arrays intermedios: se lee un píxel, se transforma y se escribe.
// -------------------------------------------------------------------------
function applyConstants(srcData, dst, count, k, dstChannels, levelsLut) {
    const p = spaceParams(k.filter);
    const m = k.m, M = k.M;
    const inv = 255.0 / k.range;
    const lo = k.lo;

    for (let i = 0; i < count; i++) {
        const s = i * 4;
        forwardPixel(p, srcData[s], srcData[s + 1], srcData[s + 2], _fwd);
        const v1 = _fwd[0] - m[0], v2 = _fwd[1] - m[1], v3 = _fwd[2] - m[2];

        inversePixel(p,
            M[0][0] * v1 + M[0][1] * v2 + M[0][2] * v3 + m[0],
            M[1][0] * v1 + M[1][1] * v2 + M[1][2] * v3 + m[1],
            M[2][0] * v1 + M[2][1] * v2 + M[2][2] * v3 + m[2],
            _inv);

        const d = i * dstChannels;
        for (let c = 0; c < 3; c++) {
            let val = _inv[c];
            if (!isFinite(val)) val = 128;
            let out = Math.round((val - lo) * inv);
            out = out < 0 ? 0 : (out > 255 ? 255 : out);
            dst[d + c] = levelsLut ? levelsLut[out] : out;
        }
        if (dstChannels === 4) dst[d + 3] = 255;
    }
}

/**
 * Curva de niveles (punto negro, gamma, punto blanco) como tabla de 256
 * entradas. Es exactamente lo que hace el shader de la previsualización,
 * así que la exportación coincide con lo que se ve en pantalla.
 */
function buildLevelsLut(levels) {
    if (!levels) return null;
    const black = levels.black, white = levels.white, gamma = levels.gamma;
    if (black === 0 && white === 255 && Math.abs(gamma - 1) < 1e-9) return null;

    const lut = new Uint8ClampedArray(256);
    const range = Math.max(white - black, 1e-5) / 255.0;
    const b = black / 255.0;
    const invGamma = 1.0 / gamma;

    for (let i = 0; i < 256; i++) {
        let t = ((i / 255.0) - b) / range;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        lut[i] = Math.round(Math.pow(t, invGamma) * 255.0);
    }
    return lut;
}

// -------------------------------------------------------------------------
// FILTROS ESTRUCTURALES (DoG y máscara de enfoque)
//
// Estos SÍ dependen de los píxeles vecinos, así que no son estrictamente
// independientes por píxel. Se resuelven igual por bandas, añadiendo un
// margen vertical del tamaño del radio del desenfoque y descartándolo
// después.
//
// El desenfoque se calcula de forma separable (una pasada horizontal y otra
// vertical) en vez de con las 25 muestras del núcleo 5x5. Es válido porque
// el núcleo es el producto de dos binomiales y porque el desenfoque
// horizontal conmuta con la interpolación vertical, al ser ambos lineales.
// En una imagen de 100 Mpx la diferencia es entre segundos y minutos.
// -------------------------------------------------------------------------
const BINOMIAL = [0.0625, 0.25, 0.375, 0.25, 0.0625];

function lumaOf(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Desenfoque horizontal de una fila, muestreando a posiciones fraccionarias
 * con interpolación lineal y bordes fijados (equivalente a CLAMP_TO_EDGE).
 * Trabaja sobre luminancia, que es lo único que usan ambos filtros.
 */
function blurRowH(lumaRow, w, scale, out) {
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -2; i <= 2; i++) {
            let sx = x + i * scale;
            if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1;
            const x0 = sx | 0;
            const x1 = x0 + 1 > w - 1 ? w - 1 : x0 + 1;
            const f = sx - x0;
            acc += BINOMIAL[i + 2] * (lumaRow[x0] + (lumaRow[x1] - lumaRow[x0]) * f);
        }
        out[x] = acc;
    }
}

/**
 * Aplica DoG o máscara de enfoque a una banda.
 *
 * srcData cubre las filas [bandY0 - margin, bandY1 + margin) de la imagen.
 * Se devuelven solo las filas útiles.
 *
 * scaleFactor adapta los radios a la resolución: los del shader están
 * definidos sobre la previsualización, así que en una exportación a
 * resolución completa hay que multiplicarlos por la relación de tamaños,
 * o el efecto saldría mucho más fino que el que se vio en pantalla.
 */
// -------------------------------------------------------------------------
// CODIFICADOR PNG
//
// Escribir el PNG a mano evita por completo el elemento <canvas>, que es lo
// que impone el techo de tamaño en los navegadores (y muy especialmente en
// Safari de iOS). Sin canvas no hay límite de área: solo el tamaño que el
// archivo pueda ocupar.
//
// Un PNG es: firma, cabecera IHDR, uno o varios bloques IDAT con las filas
// comprimidas en formato zlib, y el cierre IEND. La compresión la hace el
// propio navegador con CompressionStream('deflate'), que produce justo el
// envoltorio zlib que espera IDAT.
// -------------------------------------------------------------------------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const len = data.length;
    const out = new Uint8Array(len + 12);
    const view = new DataView(out.buffer);
    view.setUint32(0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(len + 8, crc32(out.subarray(4, 8 + len)));
    return out;
}

/**
 * Filtro Paeth (tipo 4). Es el que mejor comprime en fotografía y cuesta
 * poco: unas pocas operaciones por byte.
 */
function paethFilterRow(cur, prev, w, out) {
    const bpp = 3;
    out[0] = 4;
    for (let i = 0; i < w * bpp; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = (i >= bpp && prev) ? prev[i - bpp] : 0;
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        out[i + 1] = (cur[i] - pred) & 0xFF;
    }
}

class PngWriter {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.rowBytes = width * 3;
        this.prevRow = null;
        this.curFiltered = new Uint8Array(this.rowBytes + 1);

        const ihdr = new Uint8Array(13);
        const dv = new DataView(ihdr.buffer);
        dv.setUint32(0, width);
        dv.setUint32(4, height);
        ihdr[8] = 8;    // 8 bits por canal
        ihdr[9] = 2;    // color tipo 2: RGB sin alfa (25 % menos que RGBA)
        ihdr[10] = 0;   // compresión deflate
        ihdr[11] = 0;   // método de filtrado estándar
        ihdr[12] = 0;   // sin entrelazado

        this.parts = [
            new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            pngChunk('IHDR', ihdr)
        ];

        this.stream = new CompressionStream('deflate');
        this.writer = this.stream.writable.getWriter();
        this.compressed = [];
        this.reading = this.drain();
    }

    async drain() {
        const reader = this.stream.readable.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            this.compressed.push(value);
        }
    }

    async writeRow(rgbRow) {
        paethFilterRow(rgbRow, this.prevRow, this.width, this.curFiltered);
        await this.writer.write(this.curFiltered.slice());
        if (!this.prevRow) this.prevRow = new Uint8Array(this.rowBytes);
        this.prevRow.set(rgbRow.subarray(0, this.rowBytes));
    }

    async finish() {
        await this.writer.close();
        await this.reading;

        // Un IDAT por bloque comprimido: es válido y evita tener que
        // concatenar todo en un único buffer contiguo.
        for (const chunk of this.compressed) this.parts.push(pngChunk('IDAT', chunk));
        this.parts.push(pngChunk('IEND', new Uint8Array(0)));

        return new Blob(this.parts, { type: 'image/png' });
    }
}

// -------------------------------------------------------------------------
// MENSAJES
// -------------------------------------------------------------------------
self.onmessage = function (e) {
    const data = e.data || {};
    if (data.type === 'export') {
        handleExport(data).catch(err => {
            self.postMessage({
                type: 'export',
                error: (err && err.message) ? err.message : String(err),
                jobId: data.jobId
            });
        });
        return;
    }
    handleProcess(data);
};

self.onerror = function () {
    self.postMessage({ error: "Error interno del procesador de imagen.", version: null });
};

function handleProcess(data) {
    const version = data.version;
    try {
        const { imgData, filter, targetStd, roi } = data;

        if (!imgData || !imgData.data || imgData.width <= 0 || imgData.height <= 0) {
            throw new Error("La estructura de la imagen recibida no es válida.");
        }
        const w = imgData.width, h = imgData.height;
        const numPixels = w * h;
        if (imgData.data.length < numPixels * 4) {
            throw new Error("Los datos de la imagen están incompletos.");
        }

        const constants = computeConstants(imgData.data, w, h, filter, targetStd, roi);

        const dstUint8 = new Uint8ClampedArray(numPixels * 4);
        applyConstants(imgData.data, dstUint8, numPixels, constants, 4, null);

        self.postMessage({ dstUint8, constants, version }, [dstUint8.buffer]);

    } catch (err) {
        self.postMessage({
            error: (err && err.message) ? err.message : String(err),
            version
        });
    }
}

/**
 * EXPORTACIÓN A RESOLUCIÓN COMPLETA
 *
 * Decodifica el archivo original, lo recorre por bandas horizontales y va
 * escribiendo el PNG fila a fila. La memoria en uso no depende del tamaño
 * de la imagen, solo del de la banda.
 */
async function handleExport(job) {
    const { jobId, blob, constants, kind, amount, levels, previewWidth } = job;
    const mode = job.mode || 'processed';

    const report = (stage, progress) => {
        self.postMessage({ type: 'export-progress', jobId, stage, progress });
    };

    report('decodificando', 0);

    let bitmap;
    try {
        bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (err) {
        throw new Error("No se pudo volver a abrir la imagen original para exportarla.");
    }

    const W = bitmap.width, H = bitmap.height;
    if (!W || !H) throw new Error("La imagen original no tiene dimensiones utilizables.");

    const levelsLut = buildLevelsLut(levels);
    const isStructural = (kind === 'dog' || kind === 'unsharp_mask');

    // Los radios del filtro estructural están definidos sobre la
    // previsualización. Si no se escalan, el efecto sale mucho más fino que
    // el que el usuario aprobó en pantalla.
    const resScale = (isStructural && previewWidth > 0) ? (W / previewWidth) : 1;
    const margin = isStructural ? Math.ceil(2 * 4.0 * resScale) + 2 : 0;

    let stripRows = Math.max(1, Math.floor(STRIP_TARGET_PIXELS / W));
    if (stripRows > H) stripRows = H;

    const canvas = new OffscreenCanvas(W, Math.min(H, stripRows + margin * 2));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error("No se pudo preparar el lienzo de trabajo.");

    // La comparativa lado a lado se arma fila a fila: no hace falta un
    // lienzo del doble de ancho, que es justo lo que reventaba el límite
    // del navegador con fotos grandes.
    const outW = (mode === 'combined') ? W * 2 : W;
    const png = new PngWriter(outW, H);
    const rgbRow = new Uint8Array(outW * 3);
    const stripOut = new Uint8Array(W * stripRows * 3);

    for (let y0 = 0; y0 < H; y0 += stripRows) {
        const rows = Math.min(stripRows, H - y0);

        const readY0 = Math.max(0, y0 - margin);
        const readY1 = Math.min(H, y0 + rows + margin);
        const readRows = readY1 - readY0;

        canvas.height = readRows;
        ctx.clearRect(0, 0, W, readRows);
        ctx.drawImage(bitmap, 0, readY0, W, readRows, 0, 0, W, readRows);
        const src = ctx.getImageData(0, 0, W, readRows).data;

        const skip = y0 - readY0;

        if (mode !== 'original') {
            if (isStructural) {
                const scaled = {
                    a: (kind === 'dog' ? 1.2 : 1.8) * resScale,
                    b: 4.0 * resScale
                };
                applyStructuralScaled(src, W, readRows, skip, rows, stripOut, 3,
                                      kind, amount, levelsLut, scaled);
            } else {
                // Se salta el margen de lectura: solo interesan las filas útiles.
                applyConstants(src.subarray(skip * W * 4), stripOut, W * rows,
                               constants, 3, levelsLut);
            }
        }

        for (let r = 0; r < rows; r++) {
            if (mode === 'processed') {
                rgbRow.set(stripOut.subarray(r * W * 3, (r + 1) * W * 3));
            } else {
                // Filas del original, sin transformar ni ajustar niveles.
                const s0 = (skip + r) * W * 4;
                const base = (mode === 'combined') ? W * 3 : 0;
                for (let x = 0; x < W; x++) {
                    const si = s0 + x * 4, di = x * 3;
                    rgbRow[di] = src[si];
                    rgbRow[di + 1] = src[si + 1];
                    rgbRow[di + 2] = src[si + 2];
                }
                if (mode === 'combined') {
                    rgbRow.set(stripOut.subarray(r * W * 3, (r + 1) * W * 3), base);
                }
            }
            await png.writeRow(rgbRow);
        }

        report('procesando', (y0 + rows) / H);
    }

    bitmap.close();
    canvas.width = canvas.height = 0;

    report('comprimiendo', 1);
    const out = await png.finish();

    self.postMessage({ type: 'export', jobId, blob: out, width: outW, height: H });
}

/**
 * Aplica DoG o máscara de enfoque a una banda, con los radios ya escalados
 * a la resolución real. srcData cubre las filas con margen; se devuelven
 * solo las útiles.
 */
function applyStructuralScaled(srcData, srcW, srcH, offsetY, outRows, dst, dstChannels,
                               kind, amount, levelsLut, scales) {
    const luma = new Float32Array(srcW * srcH);
    for (let i = 0, n = srcW * srcH; i < n; i++) {
        const s = i * 4;
        luma[i] = lumaOf(srcData[s], srcData[s + 1], srcData[s + 2]);
    }

    const cacheA = new Map(), cacheB = new Map();

    const getRow = (cache, scale, y) => {
        const yy = y < 0 ? 0 : (y > srcH - 1 ? srcH - 1 : y);
        let row = cache.get(yy);
        if (row) return row;
        row = new Float32Array(srcW);
        blurRowH(luma.subarray(yy * srcW, yy * srcW + srcW), srcW, scale, row);
        cache.set(yy, row);
        return row;
    };

    const vBlur = (cache, scale, x, y) => {
        let acc = 0;
        for (let j = -2; j <= 2; j++) {
            let sy = y + j * scale;
            if (sy < 0) sy = 0; else if (sy > srcH - 1) sy = srcH - 1;
            const y0 = sy | 0;
            const y1 = y0 + 1 > srcH - 1 ? srcH - 1 : y0 + 1;
            const f = sy - y0;
            const rA = getRow(cache, scale, y0), rB = getRow(cache, scale, y1);
            acc += BINOMIAL[j + 2] * (rA[x] + (rB[x] - rA[x]) * f);
        }
        return acc;
    };

    const keep = Math.ceil(2 * scales.b) + 3;

    for (let outY = 0; outY < outRows; outY++) {
        const y = offsetY + outY;

        for (const cache of [cacheA, cacheB]) {
            for (const key of cache.keys()) {
                if (key < y - keep || key > y + keep) cache.delete(key);
            }
        }

        for (let x = 0; x < srcW; x++) {
            const d = (outY * srcW + x) * dstChannels;
            const a = vBlur(cacheA, scales.a, x, y);

            if (kind === 'dog') {
                const b = vBlur(cacheB, scales.b, x, y);
                let v = ((a - b) / 255.0) * amount + 0.5;
                v = v < 0 ? 0 : (v > 1 ? 1 : v);
                const out = Math.round(v * 255);
                const fin = levelsLut ? levelsLut[out] : out;
                dst[d] = fin; dst[d + 1] = fin; dst[d + 2] = fin;
            } else {
                const s = (y * srcW + x) * 4;
                const l = luma[y * srcW + x];
                for (let c = 0; c < 3; c++) {
                    const base = srcData[s + c];
                    const blurredC = a + (base - l);
                    let v = base + (base - blurredC) * amount;
                    v = v < 0 ? 0 : (v > 255 ? 255 : v);
                    const out = Math.round(v);
                    dst[d + c] = levelsLut ? levelsLut[out] : out;
                }
            }
            if (dstChannels === 4) dst[d + 3] = 255;
        }
    }
}
