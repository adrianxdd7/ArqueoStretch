// =========================================================================
// ARCHIVO: worker.js - PROCESAMIENTO MATRICIAL (PCA & DECORRELATION STRETCH)
// =========================================================================

/**
 * CACHE GLOBAL DE ARRAYS TIPADOS (Objetivo 1)
 * Evita la asignación y destrucción sistemática de memoria en cada ciclo de ejecución,
 * mitigando por completo la latencia por recolección de basura (Garbage Collection).
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

self.onmessage = function(e) {
    const { imgData, filter, targetStd, version } = e.data;
    
    // Validación Numérica Perimetral (Objetivo 7)
    if (!imgData || imgData.width <= 0 || imgData.height <= 0 || !imgData.data) {
        console.error("[ArqueoStretch Worker] Estructura de imagen inválida o degenerada.");
        return;
    }

    const w = imgData.width;
    const h = imgData.height;
    const numPixels = w * h;
    
    const uint8Data = imgData.data;
    
    // Fusión de recorridos: extracción de canales y cálculo simultáneo de medias
    const extraction = extractChannelsAndMeans(uint8Data, numPixels, filter);
    
    // Procesamiento Estadístico Multivariante (PCA)
    const processedChannels = decorrelationStretch(extraction.channels, extraction.means, numPixels, targetStd);
    if (!processedChannels) return; // Abortar si la matriz es totalmente degenerada
    
    let dstUint8 = new Uint8ClampedArray(numPixels * 4);
    reconstructImage(processedChannels, dstUint8, numPixels, filter);
    
    self.postMessage({ dstUint8: dstUint8, version: version }, [dstUint8.buffer]);
};

/**
 * OPTIMIZACIÓN DE RECORRIDOS (Objetivo 5)
 * Extrae los canales de color y acumula los valores para la media estadística en una única pasada regular.
 */
function extractChannelsAndMeans(data, numPixels, filter) {
    const ch1 = getCacheArray('ch1', numPixels);
    const ch2 = getCacheArray('ch2', numPixels);
    const ch3 = getCacheArray('ch3', numPixels);
    
    let sum1 = 0, sum2 = 0, sum3 = 0;

    for (let i = 0; i < numPixels; i++) {
        const idx = i * 4;
        const r = data[idx]; 
        const g = data[idx + 1]; 
        const b = data[idx + 2];

        if (filter === 'pca_rgb') {
            ch1[i] = r; ch2[i] = g; ch3[i] = b;
        } else if (filter === 'yuv_stretch') {
            // Conversión YCbCr estándar BT.601
            ch1[i] = 0.299 * r + 0.587 * g + 0.114 * b;
            ch2[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
            ch3[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
        }
        
        sum1 += ch1[i]; 
        sum2 += ch2[i]; 
        sum3 += ch3[i];
    }
    
    return {
        channels: [ch1, ch2, ch3],
        means: [sum1 / numPixels, sum2 / numPixels, sum3 / numPixels]
    };
}

/**
 * PROCESAMIENTO CIENTÍFICO: Decorrelation Stretch mediante PCA (Objetivo 4)
 * Modifica las propiedades estadísticas intrínsecas del set de datos eliminando la covarianza.
 */
function decorrelationStretch(channels, means, numPixels, targetStd) {
    const [ch1, ch2, ch3] = channels;
    const [m1, m2, m3] = means;

    // Cálculo de la Matriz de Covarianza Simétrica
    let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
    for (let i = 0; i < numPixels; i++) {
        const v1 = ch1[i] - m1; 
        const v2 = ch2[i] - m2; 
        const v3 = ch3[i] - m3;
        c00 += v1 * v1; c01 += v1 * v2; c02 += v1 * v3;
        c11 += v2 * v2; c12 += v2 * v3; c22 += v3 * v3;
    }
    
    const div = numPixels - 1;
    let cov = [
        [c00 / div, c01 / div, c02 / div],
        [c01 / div, c11 / div, c12 / div],
        [c02 / div, c12 / div, c22 / div]
    ];

    // Diagonalización mediante rotaciones de Jacobi
    const eigen = jacobiEigenDecomposition(cov);
    let V = eigen.vectors; 
    let L = eigen.values;

    // Ordenación decreciente de Autovalores (Varianza de los Componentes Principales)
    let pIndices = [0, 1, 2];
    pIndices.sort((a, b) => L[b] - L[a]);

    let sortedL = [L[pIndices[0]], L[pIndices[1]], L[pIndices[2]]];
    let sortedV = [
        [V[0][pIndices[0]], V[0][pIndices[1]], V[0][pIndices[2]]],
        [V[1][pIndices[0]], V[1][pIndices[1]], V[1][pIndices[2]]],
        [V[2][pIndices[0]], V[2][pIndices[1]], V[2][pIndices[2]]]
    ];
    L = sortedL; V = sortedV;

    /**
     * AJUSTE PRECISION EPSILON (Objetivo 3)
     * Reducido a 1e-6 para preservar el rango dinámico real de componentes hiper-sutiles.
     */
    const eps = 1e-6;
    let scales = [1.0, 1.0, 1.0];

    // Validación e igualación de varianzas (Objetivo 2 y 7)
    for (let i = 0; i < 3; i++) {
        if (isNaN(L[i]) || !isFinite(L[i])) {
            console.error(`[ArqueoStretch] Inestabilidad numérica: Autovalor no numérico o infinito detectado en L[${i}].`);
            return null;
        }
        if (L[i] < 0) {
            console.warn(`[ArqueoStretch Avisos Científicos] Autovalor negativo detectado de forma anómala (L[${i}] = ${L[i]}). ` +
                         `Origen: Error numérico de redondeo IEEE 754 bajo altísima correlación lineal o imagen plana uniforme.`);
            scales[i] = 1.0; // Conservar escala neutra sin distorsionar el componente imaginario
        } else if (L[i] > 1e-4) {
            // Eliminación estricta de Math.abs(). Solo opera sobre autovalores válidos y reales.
            scales[i] = targetStd / Math.sqrt(L[i] + eps);
        }
    }

    const out1 = getCacheArray('out1', numPixels);
    const out2 = getCacheArray('out2', numPixels);
    const out3 = getCacheArray('out3', numPixels);

    // Rotación directa al espacio PCA, normalización de varianza y rotación inversa al espacio original
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

function reconstructImage(processedChannels, dstUint8, numPixels, filter) {
    const rData = getCacheArray('rData', numPixels);
    const gData = getCacheArray('gData', numPixels);
    const bData = getCacheArray('bData', numPixels);

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
    } else {
        rData.set(processedChannels[0]);
        gData.set(processedChannels[1]);
        bData.set(processedChannels[2]);
    }

    let globalMin = Infinity;
    let globalMax = -Infinity;

    for (let i = 0; i < numPixels; i++) {
        // Sanitización estricta ante valores numéricos corruptos
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

    /**
     * MEJORA VISUAL POST-PROCESAMIENTO (Objetivo 4)
     * El reescalado lineal global mapea los resultados flotantes devueltos por el pipeline estadístico
     * al rango entero cuantizado [0, 255]. Es una adaptación para visualización en pantallas, no añade datos.
     */
    let globalRange = globalMax - globalMin;
    if (globalRange < 1e-5) globalRange = 1e-5; 

    for (let i = 0; i < numPixels; i++) {
        const idx = i * 4;
        dstUint8[idx]     = Math.min(255, Math.max(0, Math.round(((rData[i] - globalMin) / globalRange) * 255.0)));
        dstUint8[idx + 1] = Math.min(255, Math.max(0, Math.round(((gData[i] - globalMin) / globalRange) * 255.0)));
        dstUint8[idx + 2] = Math.min(255, Math.max(0, Math.round(((bData[i] - globalMin) / globalRange) * 255.0)));
        dstUint8[idx + 3] = 255;
    }
}