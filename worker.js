// =========================================================================
// ARCHIVO: worker.js - PROCESAMIENTO MATRICIAL (YXX, LXX, CRGB, PCA)
// =========================================================================

/**
 * CACHE GLOBAL DE ARRAYS TIPADOS
 */
const cache = {
    ch1: null, ch2: null, ch3: null,
    out1: null, out2: null, out3: null,
    rData: null, gData: null, bData: null
};

function getCacheArray(key, size) {
    if (!cache[key] || cache[key].length !== size) {
        cache[key] = new Float32Array(size);
    }
    return cache[key];
}

// -------------------------------------------------------------------------
// TABLAS LUT Y FUNCIONES AUXILIARES PARA ESPACIOS CIE XYZ / LAB / LXX
// -------------------------------------------------------------------------
const rgb2xyzlut = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    let v = i / 255.0;
    v = (v > 0.04045) ? Math.pow((v + 0.055) / 1.055, 2.4) : (v / 12.92);
    rgb2xyzlut[i] = v * 100.0;
}

function fLab(t) {
    return (t > 0.008856) ? Math.cbrt(t) : (7.787 * t + 0.13793103448275862);
}

function fLabInv(t) {
    const t3 = t * t * t;
    return (t3 > 0.008856) ? t3 : ((t - 0.13793103448275862) / 7.787);
}

function xyz2rgbVal(val) {
    let v = val / 100.0;
    if (v <= 0) return 0;
    v = (v > 0.0031308) ? (1.055 * Math.pow(v, 0.4166666666666667) - 0.055) : (12.92 * v);
    return Math.min(255, Math.max(0, Math.round(v * 255.0)));
}

// -------------------------------------------------------------------------
// RECEPCIÓN DE MENSAJES EN EL WORKER
// -------------------------------------------------------------------------
self.onmessage = function(e) {
    const { imgData, filter, targetStd, version, roi } = e.data;
    
    if (!imgData || imgData.width <= 0 || imgData.height <= 0 || !imgData.data) {
        console.error("[ArqueoStretch Worker] Estructura de imagen inválida.");
        return;
    }

    const w = imgData.width;
    const h = imgData.height;
    const numPixels = w * h;
    const uint8Data = imgData.data;

    const roiIndices = buildRoiIndices(w, h, roi);
    
    // Extracción de canales y cálculo de medias estadísticas
    const extraction = extractChannelsAndMeans(uint8Data, numPixels, filter, roiIndices);
    
    // Procesamiento PCA o Matriz Fija CRGB
    const processedChannels = decorrelationStretch(extraction.channels, extraction.means, numPixels, targetStd, filter, roiIndices);
    if (!processedChannels) return;
    
    let dstUint8 = new Uint8ClampedArray(numPixels * 4);
    reconstructImage(processedChannels, extraction.means, dstUint8, numPixels, filter);
    
    self.postMessage({ dstUint8: dstUint8, version: version }, [dstUint8.buffer]);
};

function buildRoiIndices(w, h, roi) {
    if (!roi) return null;

    const x0 = Math.max(0, Math.floor(roi.x));
    const y0 = Math.max(0, Math.floor(roi.y));
    const x1 = Math.min(w, Math.ceil(roi.x + roi.w));
    const y1 = Math.min(h, Math.ceil(roi.y + roi.h));
    if (x1 <= x0 || y1 <= y0) return null;

    const count = (x1 - x0) * (y1 - y0);
    const indices = new Int32Array(count);
    let k = 0;
    for (let y = y0; y < y1; y++) {
        const rowStart = y * w;
        for (let x = x0; x < x1; x++) {
            indices[k++] = rowStart + x;
        }
    }
    return indices;
}

// -------------------------------------------------------------------------
// TRANSFORMACIÓN DIRECTA A ESPACIOS VECTORIALES DE DSTRETCH
// -------------------------------------------------------------------------
function extractChannelsAndMeans(data, numPixels, filter, roiIndices) {
    const ch1 = getCacheArray('ch1', numPixels);
    const ch2 = getCacheArray('ch2', numPixels);
    const ch3 = getCacheArray('ch3', numPixels);

    // Configuración de coeficientes por espacio
    let ky = 1.0, ku = 0.5, kv = 1.0; // YDS por defecto
    if (filter === 'ybr') { ky = 1.0; ku = 0.8; kv = 0.4; }
    else if (filter === 'ybk') { ky = 1.5; ku = 0.2; kv = 1.6; }
    else if (filter === 'yre') { ky = 8.0; ku = 1.0; kv = 0.4; }

    let Lm1 = 0.5, Lm2 = 0.5, Am = 1.0, Bm = 1.0; // LAB por defecto
    if (filter === 'lds') { Lm1 = 0.5; Lm2 = 0.5; Am = 0.9; Bm = 0.5; }
    else if (filter === 'lre') { Lm1 = 0.5; Lm2 = 0.5; Am = 0.5; Bm = 1.0; }

    const isYXX = ['yds', 'ybr', 'ybk', 'yre'].includes(filter);
    const isLXX = ['lab', 'lds', 'lre'].includes(filter);

    for (let i = 0; i < numPixels; i++) {
        const idx = i * 4;
        const r = data[idx]; 
        const g = data[idx + 1]; 
        const b = data[idx + 2];

        if (filter === 'pca_rgb' || filter === 'crgb') {
            ch1[i] = r; ch2[i] = g; ch3[i] = b;
        } else if (filter === 'yuv_stretch') {
            ch1[i] = 0.299 * r + 0.587 * g + 0.114 * b;
            ch2[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
            ch3[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
        } else if (isYXX) {
            const y = 0.299 * r + 0.587 * g + 0.114 * b;
            ch1[i] = y;
            ch2[i] = ky * (b - ku * y);
            ch3[i] = ky * (r - kv * y);
        } else if (isLXX) {
            const rX = rgb2xyzlut[r];
            const gX = rgb2xyzlut[g];
            const bX = rgb2xyzlut[b];

            const X = rX * 0.4124 + gX * 0.3576 + bX * 0.1805;
            const Y = rX * 0.2126 + gX * 0.7152 + bX * 0.0722;
            const Z = rX * 0.0193 + gX * 0.1192 + bX * 0.9505;

            const fX = fLab(X / 95.047);
            const fY = fLab(Y / 100.000);
            const fZ = fLab(Z / 108.883);

            ch1[i] = 116.0 * fY - 16.0;
            ch2[i] = (250.0 / Lm1) * (fX - Am * fY);
            ch3[i] = (100.0 / Lm2) * (Bm * fY - fZ);
        }
    }

    let sum1 = 0, sum2 = 0, sum3 = 0;
    const statCount = roiIndices ? roiIndices.length : numPixels;

    if (roiIndices) {
        for (let k = 0; k < roiIndices.length; k++) {
            const i = roiIndices[k];
            sum1 += ch1[i]; sum2 += ch2[i]; sum3 += ch3[i];
        }
    } else {
        for (let i = 0; i < numPixels; i++) {
            sum1 += ch1[i]; sum2 += ch2[i]; sum3 += ch3[i];
        }
    }
    
    return {
        channels: [ch1, ch2, ch3],
        means: [sum1 / statCount, sum2 / statCount, sum3 / statCount]
    };
}

// -------------------------------------------------------------------------
// DESCORRELACIÓN PCA Y MATRIZ CRGB
// -------------------------------------------------------------------------
function decorrelationStretch(channels, means, numPixels, targetStd, filter, roiIndices) {
    const [ch1, ch2, ch3] = channels;
    const [m1, m2, m3] = means;

    const out1 = getCacheArray('out1', numPixels);
    const out2 = getCacheArray('out2', numPixels);
    const out3 = getCacheArray('out3', numPixels);

    // MATRIZ FIJA CRGB (Sin PCA, multiplicación directa de DStretch)
    if (filter === 'crgb') {
        const scale = targetStd / 10.0;
        const m00 = 0.37 * scale,  m01 = 0.34 * scale,  m02 = 0.30 * scale;
        const m10 = -3.80 * scale, m11 = 7.70 * scale,  m12 = -4.00 * scale;
        const m20 = -1.80 * scale, m21 = 0.22 * scale,  m22 = 2.00 * scale;

        for (let i = 0; i < numPixels; i++) {
            const v1 = ch1[i] - m1;
            const v2 = ch2[i] - m2;
            const v3 = ch3[i] - m3;

            out1[i] = m00 * v1 + m01 * v2 + m02 * v3 + m1;
            out2[i] = m10 * v1 + m11 * v2 + m12 * v3 + m2;
            out3[i] = m20 * v1 + m21 * v2 + m22 * v3 + m3;
        }
        return [out1, out2, out3];
    }

    // Ajuste de escala para espacio LRE (DStretch reduce la escala a la mitad por alta sensibilidad)
    let effectiveTargetStd = targetStd;
    if (filter === 'lre') effectiveTargetStd *= 0.5;

    // Cálculo de la Matriz de Covarianza Simétrica 3x3
    let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
    const statCount = roiIndices ? roiIndices.length : numPixels;

    if (roiIndices) {
        for (let k = 0; k < roiIndices.length; k++) {
            const i = roiIndices[k];
            const v1 = ch1[i] - m1; const v2 = ch2[i] - m2; const v3 = ch3[i] - m3;
            c00 += v1 * v1; c01 += v1 * v2; c02 += v1 * v3;
            c11 += v2 * v2; c12 += v2 * v3; c22 += v3 * v3;
        }
    } else {
        for (let i = 0; i < numPixels; i++) {
            const v1 = ch1[i] - m1; const v2 = ch2[i] - m2; const v3 = ch3[i] - m3;
            c00 += v1 * v1; c01 += v1 * v2; c02 += v1 * v3;
            c11 += v2 * v2; c12 += v2 * v3; c22 += v3 * v3;
        }
    }
    
    const div = Math.max(1, statCount - 1);
    let cov = [
        [c00 / div, c01 / div, c02 / div],
        [c01 / div, c11 / div, c12 / div],
        [c02 / div, c12 / div, c22 / div]
    ];

    const eigen = jacobiEigenDecomposition(cov);
    let V = eigen.vectors; 
    let L = eigen.values;

    let pIndices = [0, 1, 2];
    pIndices.sort((a, b) => L[b] - L[a]);

    let sortedL = [L[pIndices[0]], L[pIndices[1]], L[pIndices[2]]];
    let sortedV = [
        [V[0][pIndices[0]], V[0][pIndices[1]], V[0][pIndices[2]]],
        [V[1][pIndices[0]], V[1][pIndices[1]], V[1][pIndices[2]]],
        [V[2][pIndices[0]], V[2][pIndices[1]], V[2][pIndices[2]]]
    ];
    L = sortedL; V = sortedV;

    const eps = 1e-6;
    let scales = [1.0, 1.0, 1.0];

    for (let i = 0; i < 3; i++) {
        if (isNaN(L[i]) || !isFinite(L[i])) return null;
        if (L[i] < 0) {
            scales[i] = 1.0;
        } else if (L[i] > 1e-4) {
            scales[i] = effectiveTargetStd / Math.sqrt(L[i] + eps);
        }
    }

    // Rotación PCA -> Estiramiento -> Map Back (Rotación Inversa)
    for (let i = 0; i < numPixels; i++) {
        const v1 = ch1[i] - m1; const v2 = ch2[i] - m2; const v3 = ch3[i] - m3;
        
        const p0 = V[0][0] * v1 + V[1][0] * v2 + V[2][0] * v3;
        const p1 = V[0][1] * v1 + V[1][1] * v2 + V[2][1] * v3;
        const p2 = V[0][2] * v1 + V[1][2] * v2 + V[2][2] * v3;

        const sp0 = p0 * scales[0]; 
        const sp1 = p1 * scales[1]; 
        const sp2 = p2 * scales[2];

        out1[i] = V[0][0] * sp0 + V[0][1] * sp1 + V[0][2] * sp2 + m1;
        out2[i] = V[1][0] * sp0 + V[1][1] * sp1 + V[1][2] * sp2 + m2;
        out3[i] = V[2][0] * sp0 + V[2][1] * sp1 + V[2][2] * sp2 + m3;
    }
    return [out1, out2, out3];
}

function jacobiEigenDecomposition(A) {
    let V = [[1,0,0], [0,1,0], [0,0,1]];
    let M = [[A[0][0], A[0][1], A[0][2]], [A[1][0], A[1][1], A[1][2]], [A[2][0], A[2][1], A[2][2]]];
    const maxIterations = 50; const tolerance = 1e-10;

    for (let iter = 0; iter < maxIterations; iter++) {
        let p = 0, q = 1; let maxVal = Math.abs(M[0][1]);
        if (Math.abs(M[0][2]) > maxVal) { maxVal = Math.abs(M[0][2]); p = 0; q = 2; }
        if (Math.abs(M[1][2]) > maxVal) { maxVal = Math.abs(M[1][2]); p = 1; q = 2; }

        if (maxVal < tolerance) break;

        let theta = (M[q][q] - M[p][p]) / (2.0 * M[p][q]);
        let t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(1.0 + theta * theta));
        if (theta === 0) t = 1.0;
        
        let c = 1.0 / Math.sqrt(1.0 + t * t); let s = t * c; let tau = s / (1.0 + c);
        let m_pp = M[p][p]; let m_qq = M[q][q]; let m_pq = M[p][q];

        M[p][p] = m_pp - t * m_pq; M[q][q] = m_qq + t * m_pq; M[p][q] = 0.0; M[q][p] = 0.0;

        for (let r = 0; r < 3; r++) {
            if (r !== p && r !== q) {
                let m_rp = M[r][p]; let m_rq = M[r][q];
                M[r][p] = m_rp - s * (m_rq + m_rp * tau); M[p][r] = M[r][p];
                M[r][q] = m_rq + s * (m_rp - m_rq * tau); M[q][r] = M[r][q];
            }
            let v_rp = V[r][p]; let v_rq = V[r][q];
            V[r][p] = v_rp - s * (v_rq + v_rp * tau); V[r][q] = v_rq + s * (v_rp - v_rq * tau);
        }
    }
    return { values: [M[0][0], M[1][1], M[2][2]], vectors: V };
}

// -------------------------------------------------------------------------
// MAPEO INVERSO Y RECONSTRUCCIÓN A RGB DE SALIDA
// -------------------------------------------------------------------------
function reconstructImage(processedChannels, means, dstUint8, numPixels, filter) {
    const rData = getCacheArray('rData', numPixels);
    const gData = getCacheArray('gData', numPixels);
    const bData = getCacheArray('bData', numPixels);

    const isYXX = ['yds', 'ybr', 'ybk', 'yre'].includes(filter);
    const isLXX = ['lab', 'lds', 'lre'].includes(filter);

    if (filter === 'yuv_stretch') {
        const [Y, Cb, Cr] = processedChannels;
        for (let i = 0; i < numPixels; i++) {
            let yVal = Y[i];
            let cbVal = Cb[i] - 128;
            let crVal = Cr[i] - 128;

            rData[i] = yVal + 1.402 * crVal;
            gData[i] = yVal - 0.344136 * cbVal - 0.714136 * crVal;
            bData[i] = yVal + 1.772 * cbVal;
        }
    } else if (isYXX) {
        let ky = 1.0, ku = 0.5, kv = 1.0;
        if (filter === 'ybr') { ky = 1.0; ku = 0.8; kv = 0.4; }
        else if (filter === 'ybk') { ky = 1.5; ku = 0.2; kv = 1.6; }
        else if (filter === 'yre') { ky = 8.0; ku = 1.0; kv = 0.4; }

        const [Y, U, V] = processedChannels;
        for (let i = 0; i < numPixels; i++) {
            const y = Y[i];
            const u = U[i];
            const v = V[i];

            const r = (v / ky) + kv * y;
            const b = (u / ky) + ku * y;
            const g = 1.70358 * (y - 0.299 * r - 0.114 * b);

            rData[i] = r;
            gData[i] = g;
            bData[i] = b;
        }
    } else if (isLXX) {
        let Lm1 = 0.5, Lm2 = 0.5, Am = 1.0, Bm = 1.0;
        if (filter === 'lds') { Lm1 = 0.5; Lm2 = 0.5; Am = 0.9; Bm = 0.5; }
        else if (filter === 'lre') { Lm1 = 0.5; Lm2 = 0.5; Am = 0.5; Bm = 1.0; }

        const [L, A, B] = processedChannels;
        for (let i = 0; i < numPixels; i++) {
            const lVal = L[i];
            const aVal = A[i];
            const bVal = B[i];

            const fY = (lVal + 16.0) / 116.0;
            const fX = (Lm1 * aVal / 250.0) + Am * fY;
            const fZ = Bm * fY - (Lm2 * bVal / 100.0);

            const X = 95.047 * fLabInv(fX);
            const Y = 100.000 * fLabInv(fY);
            const Z = 108.883 * fLabInv(fZ);

            const rLin = X * 0.032406 + Y * -0.015372 + Z * -0.004986;
            const gLin = X * -0.009689 + Y * 0.018758 + Z * 0.000415;
            const bLin = X * 0.000557 + Y * -0.002040 + Z * 0.010570;

            rData[i] = xyz2rgbVal(rLin * 100.0);
            gData[i] = xyz2rgbVal(gLin * 100.0);
            bData[i] = xyz2rgbVal(bLin * 100.0);
        }
    } else {
        rData.set(processedChannels[0]);
        gData.set(processedChannels[1]);
        bData.set(processedChannels[2]);
    }

    let globalMin = Infinity, globalMax = -Infinity;
    for (let i = 0; i < numPixels; i++) {
        if (isNaN(rData[i]) || !isFinite(rData[i])) rData[i] = 128.0;
        if (isNaN(gData[i]) || !isFinite(gData[i])) gData[i] = 128.0;
        if (isNaN(bData[i]) || !isFinite(bData[i])) bData[i] = 128.0;

        if (rData[i] < globalMin) globalMin = rData[i];
        if (gData[i] < globalMin) globalMin = gData[i];
        if (bData[i] < globalMin) globalMin = bData[i];

        if (rData[i] > globalMax) globalMax = rData[i];
        if (gData[i] > globalMax) globalMax = gData[i];
        if (bData[i] > globalMax) globalMax = bData[i];
    }

    let globalRange = globalMax - globalMin;
    if (globalRange < 1e-5) globalRange = 1e-5;

    /**
     * ESTIRAMIENTO ROBUSTO POR PERCENTILES (sustituye al min/max literal)
     * Estirar contra el mínimo y el máximo absolutos es muy vulnerable a 2-3 píxeles atípicos
     * (ruido del sensor, un reflejo, polvo en el objetivo): esos pocos píxeles bastan para que
     * el resto de la imagen quede aplastado en una banda estrecha de grises, con muy poco
     * contraste real. Los espacios con ganancias muy altas (p. ej. YRE, ky=8.0) amplifican
     * también esos atípicos, agravando el problema.
     * En su lugar, se calcula un histograma y se recorta un pequeño porcentaje de las muestras
     * más extremas en cada extremo antes de estirar — el mismo principio que usa DStretch/ImageJ
     * en su función de autocontraste.
     */
    const NBINS = 2048;
    const bins = new Uint32Array(NBINS);
    const binScale = (NBINS - 1) / globalRange;

    for (let i = 0; i < numPixels; i++) {
        bins[Math.min(NBINS - 1, Math.max(0, Math.round((rData[i] - globalMin) * binScale)))]++;
        bins[Math.min(NBINS - 1, Math.max(0, Math.round((gData[i] - globalMin) * binScale)))]++;
        bins[Math.min(NBINS - 1, Math.max(0, Math.round((bData[i] - globalMin) * binScale)))]++;
    }

    const totalSamples = numPixels * 3;
    const CLIP_FRACTION = 0.005; // recorta el 0.5% de muestras más extremas por cada lado
    const clipCount = Math.floor(totalSamples * CLIP_FRACTION);

    let cum = 0, loBin = 0;
    for (let b = 0; b < NBINS; b++) {
        cum += bins[b];
        if (cum > clipCount) { loBin = b; break; }
    }
    cum = 0; let hiBin = NBINS - 1;
    for (let b = NBINS - 1; b >= 0; b--) {
        cum += bins[b];
        if (cum > clipCount) { hiBin = b; break; }
    }

    let loValue = globalMin + loBin / binScale;
    let hiValue = globalMin + hiBin / binScale;
    if (hiValue <= loValue) { loValue = globalMin; hiValue = globalMax; } // salvaguarda ante casos degenerados

    globalMin = loValue;
    globalRange = hiValue - loValue;
    if (globalRange < 1e-5) globalRange = 1e-5;

    for (let i = 0; i < numPixels; i++) {
        const idx = i * 4;
        dstUint8[idx]     = Math.min(255, Math.max(0, Math.round(((rData[i] - globalMin) / globalRange) * 255.0)));
        dstUint8[idx + 1] = Math.min(255, Math.max(0, Math.round(((gData[i] - globalMin) / globalRange) * 255.0)));
        dstUint8[idx + 2] = Math.min(255, Math.max(0, Math.round(((bData[i] - globalMin) / globalRange) * 255.0)));
        dstUint8[idx + 3] = 255;
    }
}