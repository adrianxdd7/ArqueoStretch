/* =========================================================================
 * ArqueoStretch - app.js
 * Interfaz, pipeline de GPU y coordinación con el worker de procesamiento.
 * ========================================================================= */

const APP_VERSION = "0.8";

/* -------------------------------------------------------------------------
 * Caché de referencias al DOM.
 * Antes había más de 100 document.getElementById repartidos, varios dentro
 * de funciones que se ejecutan en cada render.
 * ---------------------------------------------------------------------- */
const _elCache = new Map();
function el(id) {
    if (!_elCache.has(id)) _elCache.set(id, document.getElementById(id));
    return _elCache.get(id);
}

/* -------------------------------------------------------------------------
 * Escala de intensidad normalizada (0-100 %)
 *
 * El slider ahora es siempre 0-100 y cada algoritmo lo traduce a su propio
 * rango. Antes el mismo número significaba cosas muy distintas según el
 * filtro (targetStd directo en PCA, /10 en CRGB, /5 en DoG, /45 en Unsharp),
 * así que cambiar de algoritmo daba saltos enormes sin tocar nada.
 *
 * El mapeo es logarítmico porque el efecto visual de la ganancia satura:
 * con un mapeo lineal, la mitad inferior del recorrido no se notaba.
 * ---------------------------------------------------------------------- */
const INTENSITY_SCALES = {
    pca:     { min: 5,  max: 250 },
    dog:     { min: 20, max: 250 },
    unsharp: { min: 20, max: 250 }
};

function scaleFor(filter) {
    if (filter === 'dog') return INTENSITY_SCALES.dog;
    if (filter === 'unsharp_mask') return INTENSITY_SCALES.unsharp;
    return INTENSITY_SCALES.pca;
}

function percentToValue(percent, filter) {
    const s = scaleFor(filter);
    const t = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    return s.min * Math.pow(s.max / s.min, t);
}

function valueToPercent(value, filter) {
    const s = scaleFor(filter);
    const v = Math.max(s.min, Math.min(s.max, Number(value) || s.min));
    return 100 * Math.log(v / s.min) / Math.log(s.max / s.min);
}

// Algoritmos válidos. Cualquier configuración que llegue de fuera (código
// ASW1, JSON importado, favoritos de localStorage) se valida contra esta lista.
const VALID_FILTERS = [
    'yds', 'ybr', 'ybk', 'yre',
    'lab', 'lds', 'lre',
    'crgb', 'pca_rgb', 'yuv_stretch',
    'dog', 'unsharp_mask'
];

/**
 * Pinta el relleno del slider hasta su posición actual.
 * Los sliders nativos no muestran cuánto llevas recorrido; la variable
 * --fill la consume el track en styles.css.
 */
function paintRange(sliderId) {
    const slider = el(sliderId);
    if (!slider) return;
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 100;
    const val = parseFloat(slider.value);
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    slider.style.setProperty('--fill', Math.max(0, Math.min(100, pct)) + '%');
}

function clampToSlider(sliderId, value, fallback) {
    const slider = el(sliderId);
    const n = parseFloat(value);
    if (!isFinite(n)) return fallback;
    return Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), n));
}

/* -------------------------------------------------------------------------
 * Diálogos propios (sustituyen a alert / confirm / prompt)
 * Los diálogos nativos se ven mal en móvil, algunos navegadores los bloquean
 * y rompen el estilo de la aplicación.
 * ---------------------------------------------------------------------- */
const Dialog = {
    activeResolve: null,
    lastFocus: null,

    _build(opts) {
        const backdrop = document.createElement('div');
        backdrop.className = 'dialog';
        backdrop.setAttribute('role', 'dialog');
        backdrop.setAttribute('aria-modal', 'true');

        const box = document.createElement('div');
        box.className = 'dialog__box';

        if (opts.title) {
            const h = document.createElement('h3');
            h.className = 'dialog__title';
            h.textContent = opts.title;
            box.appendChild(h);
        }

        const p = document.createElement('p');
        p.className = 'dialog__text';
        p.textContent = opts.message;
        box.appendChild(p);

        let input = null;
        if (opts.withInput) {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'input';
            input.value = opts.defaultValue || '';
            if (opts.placeholder) input.placeholder = opts.placeholder;
            box.appendChild(input);
        }

        const actions = document.createElement('div');
        actions.className = 'dialog__actions';

        let cancelBtn = null;
        if (opts.withCancel) {
            cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn';
            cancelBtn.textContent = opts.cancelLabel || 'Cancelar';
            actions.appendChild(cancelBtn);
        }

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = opts.danger ? 'btn btn--danger' : 'btn btn--primary';
        okBtn.textContent = opts.okLabel || 'Aceptar';
        actions.appendChild(okBtn);

        box.appendChild(actions);
        backdrop.appendChild(box);

        return { backdrop, okBtn, cancelBtn, input };
    },

    _show(opts) {
        return new Promise((resolve) => {
            this.lastFocus = document.activeElement;
            const { backdrop, okBtn, cancelBtn, input } = this._build(opts);

            const close = (result) => {
                document.removeEventListener('keydown', onKey, true);
                backdrop.remove();
                if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
                resolve(result);
            };

            const accept = () => close(opts.withInput ? (input.value.trim() || null) : true);
            const cancel = () => close(opts.withInput ? null : false);

            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); cancel(); }
                if (e.key === 'Enter' && (opts.withInput || document.activeElement === okBtn)) {
                    e.preventDefault(); accept();
                }
                // Ciclo de foco simple dentro del diálogo
                if (e.key === 'Tab') {
                    const focusables = backdrop.querySelectorAll('button, input');
                    if (!focusables.length) return;
                    const first = focusables[0];
                    const last = focusables[focusables.length - 1];
                    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                }
            };

            okBtn.addEventListener('click', accept);
            if (cancelBtn) cancelBtn.addEventListener('click', cancel);
            backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) cancel(); });
            document.addEventListener('keydown', onKey, true);

            document.body.appendChild(backdrop);
            (input || okBtn).focus();
            if (input) input.select();
        });
    },

    alert(message, title) {
        return this._show({ message, title: title || 'Aviso', withCancel: false });
    },

    confirm(message, title, opts) {
        return this._show({
            message,
            title: title || 'Confirmar',
            withCancel: true,
            danger: !!(opts && opts.danger),
            okLabel: (opts && opts.okLabel) || 'Aceptar'
        });
    },

    prompt(message, defaultValue, title) {
        return this._show({
            message,
            title: title || 'Introduce un nombre',
            withInput: true,
            withCancel: true,
            defaultValue
        });
    }
};

/* -------------------------------------------------------------------------
 * Avisos flotantes sobre el visor
 * El panel de telemetría está oculto en pantalla limpia, y un aria-live
 * dentro de un display:none tampoco se anuncia: los errores no llegaban
 * nunca al usuario de móvil.
 * ---------------------------------------------------------------------- */
const Toast = {
    timer: null,

    show(message, kind, durationMs) {
        const node = el('viewerToast');
        if (!node) return;
        clearTimeout(this.timer);

        node.className = 'stage__toast';
        if (kind === 'error') node.classList.add('is-error');
        else if (kind === 'warn') node.classList.add('is-warn');
        else if (kind === 'ok') node.classList.add('is-ok');

        node.textContent = message;

        if (durationMs > 0) {
            this.timer = setTimeout(() => this.hide(), durationMs);
        }
    },

    hide() {
        const node = el('viewerToast');
        if (!node) return;
        clearTimeout(this.timer);
        node.classList.add('hidden');
    }
};

/* -------------------------------------------------------------------------
 * Carga de imágenes
 * ---------------------------------------------------------------------- */
const ImageLoader = {
    async processUploadedFile(file) {
        if (!file || file.size === 0) throw new Error("El archivo está vacío.");

        const telemetry = { size: `${(file.size / (1024 * 1024)).toFixed(2)} MB`, isRaw: false };

        // Solo se leen los primeros bytes para detectar TIFF/RAW, en vez de
        // cargar el archivo entero en memoria dos veces.
        const head = new DataView(await file.slice(0, 4).arrayBuffer());
        if (head.byteLength >= 2) {
            const magic = head.getUint16(0);
            if (magic === 0x4949 || magic === 0x4D4D) {
                telemetry.isRaw = true;
                throw new Error("Este archivo es RAW/DNG/TIFF y el navegador no puede abrirlo. Conviértelo antes a JPG o PNG.");
            }
        }

        // imageOrientation explícito: las fotos verticales de móvil llevan
        // rotación EXIF y el valor por defecto no es igual en todos los
        // navegadores, así que podían salir tumbadas.
        let bitmap;
        try {
            bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (err) {
            try {
                bitmap = await createImageBitmap(file);
            } catch (err2) {
                throw new Error("No se pudo abrir la imagen. ¿Es un formato que el navegador reconozca?");
            }
        }

        return { bitmap, telemetry };
    }
};

/* -------------------------------------------------------------------------
 * Pipeline de GPU (WebGL2)
 * ---------------------------------------------------------------------- */
const WebGL2Pipeline = {
    gl: null, program: null, texture: null, vao: null,
    uniforms: {},
    lastTextureSource: null,
    maxTextureSize: 4096,

    vertexShaderSource: `#version 300 es
        in vec2 position; out vec2 vTexCoord;
        void main() {
            vTexCoord = position * 0.5 + 0.5;
            vTexCoord.y = 1.0 - vTexCoord.y;
            gl_Position = vec4(position, 0.0, 1.0);
        }`,

    fragmentShaderSource: `#version 300 es
        precision highp float;
        in vec2 vTexCoord; out vec4 fragColor;
        uniform sampler2D uTexture; uniform vec2 uResolution;
        uniform int uFilterMode; uniform vec3 uLevels; uniform float uFilterAmount;

        vec3 applyLevels(vec3 color) {
            float range = max(uLevels.z - uLevels.x, 1e-5);
            vec3 outputColor = clamp((color - uLevels.x) / range, 0.0, 1.0);
            return pow(outputColor, vec3(1.0 / uLevels.y));
        }

        vec3 getGaussianBlur(vec2 coord, float radiusScale) {
            vec2 texelSize = vec2(1.0) / uResolution;
            vec3 accum = vec3(0.0); float totalWeight = 0.0;
            float kernel[5] = float[](0.0625, 0.25, 0.375, 0.25, 0.0625);
            for (int i = -2; i <= 2; i++) {
                for (int j = -2; j <= 2; j++) {
                    vec2 offset = vec2(float(i), float(j)) * texelSize * radiusScale;
                    float weight = kernel[i + 2] * kernel[j + 2];
                    accum += texture(uTexture, clamp(coord + offset, vec2(0.0), vec2(1.0))).rgb * weight;
                    totalWeight += weight;
                }
            }
            return accum / totalWeight;
        }

        void main() {
            vec3 baseColor = texture(uTexture, vTexCoord).rgb;
            vec3 finalColor = baseColor;
            if (uFilterMode == 1) {
                vec3 blurFine = getGaussianBlur(vTexCoord, 1.2);
                vec3 blurCoarse = getGaussianBlur(vTexCoord, 4.0);
                float lumaFine = dot(blurFine, vec3(0.299, 0.587, 0.114));
                float lumaCoarse = dot(blurCoarse, vec3(0.299, 0.587, 0.114));
                finalColor = vec3((lumaFine - lumaCoarse) * uFilterAmount + 0.5);
            } else if (uFilterMode == 2) {
                vec3 blurred = getGaussianBlur(vTexCoord, 1.8);
                finalColor = baseColor + ((baseColor - blurred) * uFilterAmount);
            }
            fragColor = vec4(applyLevels(finalColor), 1.0);
        }`,

    init(canvasElement) {
        this.gl = canvasElement.getContext('webgl2', {
            alpha: false,
            antialias: false,
            // Sin esto, leer el canvas para exportar puede devolver una
            // imagen en negro: el navegador puede vaciar el buffer en cuanto
            // termina de componer el fotograma.
            preserveDrawingBuffer: true,
            powerPreference: "high-performance"
        });

        if (!this.gl) {
            throw new Error("Tu navegador no soporta WebGL2, que es lo que ArqueoStretch usa para mostrar y exportar las imágenes. Prueba con una versión más reciente de Chrome, Firefox, Edge o Safari.");
        }

        const gl = this.gl;
        const vs = this.compileShader(gl.VERTEX_SHADER, this.vertexShaderSource);
        const fs = this.compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);

        // Antes no se comprobaba nada: si el enlazado fallaba, la aplicación
        // arrancaba "bien" y simplemente no dibujaba nunca.
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(this.program);
            throw new Error("No se pudieron preparar los shaders de la tarjeta gráfica. Detalle técnico: " + log);
        }

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        // Ninguna previsualización puede superar este tamaño en ninguna de
        // sus dos dimensiones, o la textura falla y no se dibuja nada. En
        // móviles antiguos suele ser 4096; en equipos de sobremesa, 16384.
        this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;

        const uniformKeys = ["uResolution", "uFilterMode", "uLevels", "uFilterAmount"];
        uniformKeys.forEach(key => {
            this.uniforms[key] = gl.getUniformLocation(this.program, key);
        });

        const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        const posAttr = gl.getAttribLocation(this.program, "position");
        gl.enableVertexAttribArray(posAttr);
        gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);

        this.texture = gl.createTexture();
        this.lastTextureSource = null;
    },

    compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error("Error compilando el shader de la tarjeta gráfica. Detalle técnico: " + log);
        }
        return shader;
    },

    invalidateTexture() {
        this.lastTextureSource = null;
    },

    render(imageData, filterMode, levels, filterAmount) {
        if (!this.gl || !imageData || imageData.width === 0 || imageData.height === 0) return;
        const gl = this.gl;
        gl.viewport(0, 0, imageData.width, imageData.height);
        gl.useProgram(this.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        if (this.lastTextureSource !== imageData) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imageData.width, imageData.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imageData.data);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            // Sin CLAMP_TO_EDGE el modo por defecto es REPEAT, y el desenfoque
            // de DoG/Unsharp traía píxeles del lado opuesto de la imagen:
            // aparecía un marco de artefactos alrededor de toda la foto que
            // se podía confundir con trazos reales.
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.lastTextureSource = imageData;
        }

        gl.uniform2f(this.uniforms["uResolution"], imageData.width, imageData.height);
        gl.uniform1i(this.uniforms["uFilterMode"], filterMode);
        gl.uniform3f(this.uniforms["uLevels"], levels.black / 255.0, levels.gamma, levels.white / 255.0);
        gl.uniform1f(this.uniforms["uFilterAmount"], filterAmount);

        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
};

/* -------------------------------------------------------------------------
 * Tiradores de redimensionar
 * - #resizer  (vertical, solo escritorio >=1100px): reparto de ancho.
 * - #resizerV (horizontal, por debajo de 1100px): altura de la preview.
 * Ambos con ratón, dedo y teclado (role="separator" + aria-valuenow).
 * ---------------------------------------------------------------------- */
const ResizerController = {
    init() {
        this.initHorizontalSplitter();
        this.initVerticalSplitter();
    },

    initHorizontalSplitter() {
        const resizer = el('resizer');
        const container = el('mainContainer');
        if (!resizer || !container) return;

        let isDragging = false;
        let currentPercentage = 55;

        const setPercentage = (percentage) => {
            currentPercentage = Math.max(25, Math.min(75, percentage));
            document.documentElement.style.setProperty('--left-width', `${currentPercentage}%`);
            resizer.setAttribute('aria-valuenow', Math.round(currentPercentage));
        };

        const startDrag = () => {
            isDragging = true;
            resizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
        };

        const doDrag = (e) => {
            if (!isDragging) return;
            const containerRect = container.getBoundingClientRect();
            const clientX = e.clientX != null ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX);
            if (clientX == null) return;
            const newLeftWidth = clientX - containerRect.left;
            setPercentage((newLeftWidth / containerRect.width) * 100);
        };

        const stopDrag = () => {
            if (!isDragging) return;
            isDragging = false;
            resizer.classList.remove('dragging');
            document.body.style.cursor = '';
        };

        resizer.addEventListener('keydown', (e) => {
            const step = 3;
            if (e.key === 'ArrowLeft') { e.preventDefault(); setPercentage(currentPercentage - step); }
            if (e.key === 'ArrowRight') { e.preventDefault(); setPercentage(currentPercentage + step); }
        });

        resizer.addEventListener('mousedown', startDrag);
        window.addEventListener('mousemove', doDrag);
        window.addEventListener('mouseup', stopDrag);
        resizer.addEventListener('touchstart', startDrag, { passive: true });
        window.addEventListener('touchmove', doDrag, { passive: true });
        window.addEventListener('touchend', stopDrag);

        setPercentage(55);
    },

    initVerticalSplitter() {
        const resizerV = el('resizerV');
        const viewerCard = el('viewerCard');
        if (!resizerV || !viewerCard) return;

        let isDragging = false;
        let startY = 0;
        let startHeight = 0;

        const applyHeight = (newHeight) => {
            const maxHeight = window.innerHeight * 0.75;
            const clamped = Math.max(120, Math.min(maxHeight, newHeight));
            viewerCard.style.height = `${clamped}px`;
            viewerCard.style.maxHeight = 'none';
            viewerCard.style.aspectRatio = 'auto';
            resizerV.setAttribute('aria-valuenow', Math.round(clamped));
        };

        const startDrag = (e) => {
            isDragging = true;
            resizerV.classList.add('dragging');
            const clientY = e.clientY != null ? e.clientY : (e.touches && e.touches[0] && e.touches[0].clientY);
            startY = clientY || 0;
            startHeight = viewerCard.getBoundingClientRect().height;
        };

        const doDrag = (e) => {
            if (!isDragging) return;
            const clientY = e.clientY != null ? e.clientY : (e.touches && e.touches[0] && e.touches[0].clientY);
            if (clientY == null) return;
            applyHeight(startHeight + (clientY - startY));
        };

        const stopDrag = () => {
            if (!isDragging) return;
            isDragging = false;
            resizerV.classList.remove('dragging');
        };

        resizerV.addEventListener('keydown', (e) => {
            const step = 30;
            const current = viewerCard.getBoundingClientRect().height;
            if (e.key === 'ArrowUp') { e.preventDefault(); applyHeight(current - step); }
            if (e.key === 'ArrowDown') { e.preventDefault(); applyHeight(current + step); }
        });

        resizerV.addEventListener('mousedown', startDrag);
        window.addEventListener('mousemove', doDrag);
        window.addEventListener('mouseup', stopDrag);
        resizerV.addEventListener('touchstart', startDrag, { passive: true });
        window.addEventListener('touchmove', doDrag, { passive: true });
        window.addEventListener('touchend', stopDrag);
    }
};

/* -------------------------------------------------------------------------
 * Cámara (bajo demanda)
 * Antes se pedía permiso nada más abrir la página y el stream no se cerraba
 * nunca: piloto encendido y batería gastándose aunque estuvieras trabajando
 * con una foto importada.
 * ---------------------------------------------------------------------- */
const CameraController = {
    stream: null,

    get isActive() { return !!this.stream; },

    async ensure() {
        if (this.stream) return true;

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            UIController.updateStatus("Este navegador no permite usar la cámara.", "error");
            return false;
        }

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }
            });
        } catch (err) {
            const denegado = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
            UIController.updateStatus(
                denegado
                    ? "Permiso de cámara denegado. Puedes cambiarlo en los ajustes del navegador."
                    : "No se pudo acceder a la cámara de este dispositivo.",
                "error"
            );
            return false;
        }

        const video = el('videoPreview');
        video.srcObject = this.stream;
        video.classList.remove('hidden');
        el('canvasView').classList.add('hidden');
        return true;
    },

    stop() {
        if (!this.stream) return;
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
        const video = el('videoPreview');
        video.srcObject = null;
        video.classList.add('hidden');
        const label = el('captureBtnLabel');
        if (label) label.textContent = 'Usar la cámara';
    }
};

/* -------------------------------------------------------------------------
 * Histograma
 * ---------------------------------------------------------------------- */
const HistogramController = {
    // Se muestrea 1 de cada 4 píxeles: el histograma sale visualmente idéntico
    // y se evita bloquear la interfaz ~100 ms en cada recálculo.
    STEP: 4,

    draw(imageData) {
        if (!imageData || imageData.width === 0 || imageData.height === 0) return;
        const canvas = el('histogramCanvas');
        if (!canvas || canvas.clientWidth === 0) return;

        // Se dibuja a la resolución real del dispositivo: en pantallas
        // HiDPI un canvas a 1x se ve borroso, que es de los detalles que más
        // delatan una interfaz sin acabar.
        const ctx = canvas.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight || 82;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const data = imageData.data;
        const len = data.length;
        const hist = new Int32Array(256);
        const stride = 4 * this.STEP;

        let minLuma = 255, maxLuma = 0, sumLuma = 0, sumSqLuma = 0, sampled = 0;

        for (let i = 0; i < len; i += stride) {
            const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
            hist[Math.min(255, Math.max(0, Math.round(luma)))]++;
            if (luma < minLuma) minLuma = luma;
            if (luma > maxLuma) maxLuma = luma;
            sumLuma += luma;
            sumSqLuma += luma * luma;
            sampled++;
        }

        if (sampled === 0) return;

        const mean = sumLuma / sampled;
        const variance = (sumSqLuma / sampled) - (mean * mean);
        const stdDev = Math.sqrt(Math.max(0, variance));

        el('lblMean').textContent = mean.toFixed(1);
        el('lblStd').textContent = stdDev.toFixed(1);
        el('lblMin').textContent = Math.round(minLuma);
        el('lblMax').textContent = Math.round(maxLuma);

        let maxVal = 0;
        for (let i = 1; i < 255; i++) { if (hist[i] > maxVal) maxVal = hist[i]; }
        if (maxVal === 0) maxVal = 1;

        ctx.clearRect(0, 0, w, h);
        const binWidth = w / 256;

        // Relleno cian de falso color, con la cresta marcada un tono por
        // encima para que la forma del histograma se lea de un vistazo.
        ctx.fillStyle = "rgba(69, 167, 159, 0.42)";
        for (let i = 0; i < 256; i++) {
            const binHeight = (hist[i] / maxVal) * (h - 2);
            if (binHeight > 0) ctx.fillRect(i * binWidth, h - binHeight, Math.max(binWidth, 0.6), binHeight);
        }

        ctx.strokeStyle = "rgba(98, 201, 191, 0.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) {
            const y = h - (hist[i] / maxVal) * (h - 2);
            if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * binWidth, y);
        }
        ctx.stroke();
    }
};

/* -------------------------------------------------------------------------
 * Biblioteca de configuraciones guardadas
 * ---------------------------------------------------------------------- */
const FavoritesManager = {
    STORAGE_KEY: 'arqueostretch_favs',
    favorites: {},

    load() {
        let stored = null;
        try {
            stored = localStorage.getItem(this.STORAGE_KEY);
        } catch (err) {
            // Modo privado o almacenamiento bloqueado: se sigue funcionando
            // en memoria, solo que sin persistencia.
            this.favorites = {};
            this.updateDropdowns();
            return;
        }

        if (stored) {
            try { this.favorites = JSON.parse(stored) || {}; } catch (err) { this.favorites = {}; }
        }
        this.updateDropdowns();
    },

    persist() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.favorites));
            return true;
        } catch (err) {
            UIController.updateStatus("No se pudo guardar en este navegador (almacenamiento lleno o bloqueado).", "error");
            return false;
        }
    },

    async saveActive() {
        const name = await Dialog.prompt("¿Con qué nombre quieres guardar esta configuración?", "", "Guardar configuración");
        if (!name) return;

        if (Object.prototype.hasOwnProperty.call(this.favorites, name)) {
            const ok = await Dialog.confirm(
                `Ya existe una configuración llamada "${name}".\n\n¿Quieres sobrescribirla?`,
                "Nombre repetido",
                { okLabel: 'Sobrescribir', danger: true }
            );
            if (!ok) return;
        }

        const snapshot = UIController.getActiveConfig();
        this.favorites[name] = {
            filter: snapshot.filter,
            intensity: snapshot.intensity,   // valor efectivo del algoritmo
            black: snapshot.black,
            gamma: snapshot.gamma,
            white: snapshot.white
        };

        if (this.persist()) {
            this.updateDropdowns();
            el('favSelectSimple').value = name;
            if (el('favSelectPro')) el('favSelectPro').value = name;
            UIController.updateStatus(`Configuración "${name}" guardada.`, "ok", { toast: true });
        }
    },

    async deleteSelected(selectId) {
        const selectEl = el(selectId);
        const name = selectEl ? selectEl.value : '';
        if (!name) {
            UIController.updateStatus("Selecciona primero una configuración guardada.", "warn");
            return;
        }

        const ok = await Dialog.confirm(
            `¿Seguro que quieres eliminar la configuración "${name}"?`,
            "Eliminar configuración",
            { okLabel: 'Eliminar', danger: true }
        );
        if (!ok) return;

        delete this.favorites[name];
        if (this.persist()) {
            this.updateDropdowns();
            UIController.updateStatus(`Configuración "${name}" eliminada.`, "ok", { toast: true });
        }
    },

    exportLibrary() {
        const names = Object.keys(this.favorites);
        if (names.length === 0) {
            UIController.updateStatus("Todavía no has guardado ninguna configuración.", "warn");
            return;
        }
        const payload = { software: "ArqueoStretch", version: APP_VERSION, favorites: this.favorites };
        const blob = new Blob([JSON.stringify(payload, null, 4)], { type: "application/json" });
        ExportManager.downloadBlob(blob, "arqueostretch_biblioteca.json");
        UIController.updateStatus(`Biblioteca exportada (${names.length} configuraciones).`, "ok", { toast: true });
    },

    async importLibrary(file) {
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            const incoming = (data && data.favorites) ? data.favorites : data;
            if (!incoming || typeof incoming !== 'object') throw new Error("estructura inválida");

            // Se valida cada entrada: una biblioteca con un algoritmo
            // desconocido dejaba el worker produciendo imágenes de basura.
            const limpio = {};
            let descartadas = 0;
            Object.keys(incoming).forEach(name => {
                const cfg = incoming[name];
                if (cfg && typeof cfg === 'object' && VALID_FILTERS.includes(cfg.filter)) {
                    limpio[name] = {
                        filter: cfg.filter,
                        intensity: parseFloat(cfg.intensity),
                        black: clampToSlider('sliderBlack', cfg.black, 0),
                        gamma: clampToSlider('sliderGamma', cfg.gamma, 100),
                        white: clampToSlider('sliderWhite', cfg.white, 255)
                    };
                } else {
                    descartadas++;
                }
            });

            const total = Object.keys(limpio).length;
            if (total === 0) {
                UIController.updateStatus("El archivo no contiene configuraciones válidas.", "error");
                return;
            }

            this.favorites = { ...this.favorites, ...limpio };
            if (this.persist()) {
                this.updateDropdowns();
                UIController.updateStatus(
                    `Importadas ${total} configuraciones` + (descartadas ? ` (${descartadas} descartadas por no ser válidas).` : '.'),
                    "ok", { toast: true }
                );
            }
        } catch (err) {
            UIController.updateStatus("No se pudo leer el archivo de biblioteca.", "error");
        }
    },

    updateDropdowns() {
        const selects = [el('favSelectSimple'), el('favSelectPro')].filter(Boolean);
        const names = Object.keys(this.favorites).sort((a, b) => a.localeCompare(b, 'es'));

        selects.forEach(select => {
            const previo = select.value;
            select.textContent = '';

            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = names.length
                ? '-- Usar una configuración guardada --'
                : '-- Todavía no hay ninguna guardada --';
            select.appendChild(placeholder);

            names.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                select.appendChild(opt);
            });

            if (names.includes(previo)) select.value = previo;
        });
    },

    loadConfig(name) {
        const config = this.favorites[name];
        if (!config) {
            UIController.updateStatus("Esa configuración ya no existe.", "error");
            return;
        }
        if (UIController.applyConfigObject(config)) {
            UIController.updateStatus(`Configuración "${name}" aplicada.`, "ok", { toast: true });
        }
    }
};

/* -------------------------------------------------------------------------
 * Zoom y desplazamiento del visor
 * ---------------------------------------------------------------------- */
const ZoomController = {
    scale: 1, translateX: 0, translateY: 0, minScale: 1, maxScale: 8, isPanning: false,
    panOrigin: { x: 0, y: 0 },
    initialPinchDist: 0, initialScale: 1, isPinching: false,

    init() {
        this.card = el('viewerCard');
        this.inner = el('viewportInner');
        this.lbl = el('zoomLevelLabel');

        el('zoomInBtn').addEventListener('click', () => this.zoomAtCenter(1.3));
        el('zoomOutBtn').addEventListener('click', () => this.zoomAtCenter(1 / 1.3));
        el('zoomResetBtn').addEventListener('click', () => this.reset());

        this.card.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
            this.zoomAtPoint(factor, e.clientX, e.clientY);
        }, { passive: false });

        this.card.addEventListener('mousedown', (e) => this.onStart(e.clientX, e.clientY));
        window.addEventListener('mousemove', (e) => this.onMove(e.clientX, e.clientY));
        window.addEventListener('mouseup', () => this.onEnd());

        this.card.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                this.isPinching = true;
                this.isPanning = false;
                this.initialPinchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                this.initialScale = this.scale;
            } else if (e.touches.length === 1) {
                if (this.scale > 1 && !RoiSelector.drawMode) e.preventDefault();
                this.onStart(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, { passive: false });

        this.card.addEventListener('touchmove', (e) => {
            if (this.isPinching && e.touches.length === 2) {
                e.preventDefault();
                const currentDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                if (this.initialPinchDist > 0) {
                    const factor = currentDist / this.initialPinchDist;
                    const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                    const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                    this.zoomAtPointWithBaseScale(this.initialScale * factor, centerX, centerY);
                }
            } else if (this.isPanning && e.touches.length === 1) {
                e.preventDefault();
                this.onMove(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, { passive: false });

        this.card.addEventListener('touchend', (e) => {
            if (e.touches.length < 2) this.isPinching = false;
            if (e.touches.length === 0) this.onEnd();
        });
    },

    onStart(clientX, clientY) {
        if (RoiSelector.drawMode) return;
        if (this.scale <= 1) return;
        this.isPanning = true;
        // Nombres claros: antes esto era { x: <valor de Y>, xX: <valor de X> },
        // que es exactamente el tipo de detalle que hace difícil tocar el código.
        this.panOrigin = { x: clientX - this.translateX, y: clientY - this.translateY };
    },

    onMove(clientX, clientY) {
        if (!this.isPanning) return;
        this.translateX = clientX - this.panOrigin.x;
        this.translateY = clientY - this.panOrigin.y;
        this.clampTranslate();
        this.applyTransform();
    },

    onEnd() { this.isPanning = false; },

    zoomAtCenter(factor) {
        const rect = this.card.getBoundingClientRect();
        this.zoomAtPoint(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },

    zoomAtPoint(factor, clientX, clientY) {
        if (RoiSelector.drawMode) return;
        this.zoomAtPointWithBaseScale(this.scale * factor, clientX, clientY);
    },

    zoomAtPointWithBaseScale(targetScale, clientX, clientY) {
        const rect = this.card.getBoundingClientRect();
        const mouseX = clientX - rect.left;
        const mouseY = clientY - rect.top;
        const oldScale = this.scale;
        const newScale = Math.max(this.minScale, Math.min(this.maxScale, targetScale));

        if (newScale === oldScale) return;
        this.translateX = mouseX - (mouseX - this.translateX) * (newScale / oldScale);
        this.translateY = mouseY - (mouseY - this.translateY) * (newScale / oldScale);
        this.scale = newScale;
        if (this.scale === 1) { this.translateX = 0; this.translateY = 0; }
        this.clampTranslate();
        this.applyTransform();
    },

    clampTranslate() {
        const rect = this.card.getBoundingClientRect();
        const minX = rect.width * (1 - this.scale);
        const minY = rect.height * (1 - this.scale);
        this.translateX = Math.min(0, Math.max(minX, this.translateX));
        this.translateY = Math.min(0, Math.max(minY, this.translateY));
    },

    reset() {
        this.scale = 1; this.translateX = 0; this.translateY = 0;
        this.applyTransform();
    },

    applyTransform() {
        this.inner.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
        this.lbl.textContent = `${Math.round(this.scale * 100)}%`;
    }
};

/* -------------------------------------------------------------------------
 * Selección de zona (ROI)
 * ---------------------------------------------------------------------- */
const RoiSelector = {
    drawMode: false, dragging: false, startContainerPoint: null, roi: null,

    init() {
        this.card = el('viewerCard');
        this.overlay = el('roiOverlay');
        this.modeBtn = el('roiSelectModeBtn');
        this.clearBtn = el('roiClearBtn');
        this.useCheck = el('useRoiCheck');

        this.modeBtn.addEventListener('click', () => this.toggleDrawMode());
        this.clearBtn.addEventListener('click', () => this.clear());
        this.useCheck.addEventListener('change', () => UIController.dispatchProcessing());

        this.card.addEventListener('mousedown', (e) => this.onDown(e));
        this.card.addEventListener('mousemove', (e) => this.onMove(e));
        window.addEventListener('mouseup', (e) => this.onUp(e));
        this.card.addEventListener('touchstart', (e) => this.onDown(e), { passive: false });
        this.card.addEventListener('touchmove', (e) => this.onMove(e), { passive: false });
        this.card.addEventListener('touchend', (e) => this.onUp(e), { passive: false });
    },

    toggleDrawMode() {
        if (!UIController.currentOriginalData) {
            UIController.updateStatus("Carga primero una imagen para poder dibujar la selección.", "warn");
            return;
        }
        ZoomController.reset();
        this.drawMode = !this.drawMode;
        this.modeBtn.setAttribute('aria-pressed', String(this.drawMode));
        this.modeBtn.classList.toggle('btn--primary', this.drawMode);
        if (this.drawMode) {
            UIController.updateStatus("Arrastra sobre la imagen para dibujar el recuadro.", "ok", { toast: true });
        }
    },

    // silent = true al cargar una imagen nueva, para no lanzar un
    // reprocesado innecesario antes de tiempo.
    clear(silent) {
        this.roi = null;
        this.dragging = false;
        this.drawMode = false;
        this.overlay.classList.add('hidden');
        this.useCheck.checked = false;
        this.useCheck.disabled = true;
        this.modeBtn.setAttribute('aria-pressed', 'false');
        this.modeBtn.classList.remove('btn--primary');
        if (!silent) UIController.dispatchProcessing();
    },

    getActiveRoi() {
        return (this.useCheck && this.useCheck.checked && this.roi) ? this.roi : null;
    },

    /**
     * Recupera una selección tras cambiar la resolución de trabajo. Las
     * coordenadas están en píxeles de la previsualización, así que hay que
     * escalarlas; si no, el recuadro apuntaría a otra parte de la foto.
     */
    restoreScaled(roi, escala, activa, imgW, imgH) {
        const x = Math.round(roi.x * escala);
        const y = Math.round(roi.y * escala);
        const w = Math.round(roi.w * escala);
        const h = Math.round(roi.h * escala);
        if (w < 8 || h < 8) return;

        this.roi = {
            x: Math.max(0, Math.min(imgW - 1, x)),
            y: Math.max(0, Math.min(imgH - 1, y)),
            w: Math.min(w, imgW - x),
            h: Math.min(h, imgH - y)
        };
        this.useCheck.disabled = false;
        this.useCheck.checked = !!activa;
        this.redrawOverlay(imgW, imgH);
    },

    // Camino inverso a toImageCoords: de coordenadas de imagen a la caja.
    redrawOverlay(imgW, imgH) {
        if (!this.roi) return;
        const rect = this.card.getBoundingClientRect();
        if (!rect.width || !rect.height || !imgW || !imgH) return;

        const imgRatio = imgW / imgH, boxRatio = rect.width / rect.height;
        let renderW, renderH, offsetX, offsetY;
        if (imgRatio > boxRatio) {
            renderW = rect.width; renderH = rect.width / imgRatio;
            offsetX = 0; offsetY = (rect.height - renderH) / 2;
        } else {
            renderH = rect.height; renderW = rect.height * imgRatio;
            offsetY = 0; offsetX = (rect.width - renderW) / 2;
        }

        this.overlay.style.left = (offsetX + this.roi.x / imgW * renderW) + 'px';
        this.overlay.style.top = (offsetY + this.roi.y / imgH * renderH) + 'px';
        this.overlay.style.width = (this.roi.w / imgW * renderW) + 'px';
        this.overlay.style.height = (this.roi.h / imgH * renderH) + 'px';
        this.overlay.classList.remove('hidden');
    },

    getImageElement() {
        const canvas = el('canvasView');
        return canvas.classList.contains('hidden') ? el('videoPreview') : canvas;
    },

    containerPoint(evt) {
        const rect = this.card.getBoundingClientRect();
        const point = (evt.touches && evt.touches[0]) || (evt.changedTouches && evt.changedTouches[0]) || evt;
        return { x: point.clientX - rect.left, y: point.clientY - rect.top, rect };
    },

    toImageCoords(containerX, containerY, rect) {
        const element = this.getImageElement();
        const imgW = element.videoWidth || element.width;
        const imgH = element.videoHeight || element.height;
        if (!imgW || !imgH) return null;

        const boxW = rect.width, boxH = rect.height;
        const imgRatio = imgW / imgH, boxRatio = boxW / boxH;
        let renderW, renderH, offsetX, offsetY;
        if (imgRatio > boxRatio) {
            renderW = boxW; renderH = boxW / imgRatio; offsetX = 0; offsetY = (boxH - renderH) / 2;
        } else {
            renderH = boxH; renderW = boxH * imgRatio; offsetY = 0; offsetX = (boxW - renderW) / 2;
        }
        const x = (containerX - offsetX) / renderW * imgW;
        const y = (containerY - offsetY) / renderH * imgH;
        return { x: Math.max(0, Math.min(imgW, x)), y: Math.max(0, Math.min(imgH, y)) };
    },

    onDown(evt) {
        if (!this.drawMode || !UIController.currentOriginalData) return;
        evt.preventDefault();
        this.dragging = true;
        this.startContainerPoint = this.containerPoint(evt);
        this.overlay.classList.remove('hidden');
        this.overlay.style.left = this.startContainerPoint.x + 'px';
        this.overlay.style.top = this.startContainerPoint.y + 'px';
        this.overlay.style.width = '0px';
        this.overlay.style.height = '0px';
    },

    onMove(evt) {
        if (!this.dragging) return;
        evt.preventDefault();
        const p = this.containerPoint(evt);
        this.overlay.style.left = Math.min(this.startContainerPoint.x, p.x) + 'px';
        this.overlay.style.top = Math.min(this.startContainerPoint.y, p.y) + 'px';
        this.overlay.style.width = Math.abs(p.x - this.startContainerPoint.x) + 'px';
        this.overlay.style.height = Math.abs(p.y - this.startContainerPoint.y) + 'px';
    },

    onUp(evt) {
        if (!this.dragging) return;
        this.dragging = false;
        const p = this.containerPoint(evt);
        const rect = p.rect;

        const c0 = this.toImageCoords(Math.min(this.startContainerPoint.x, p.x), Math.min(this.startContainerPoint.y, p.y), rect);
        const c1 = this.toImageCoords(Math.max(this.startContainerPoint.x, p.x), Math.max(this.startContainerPoint.y, p.y), rect);
        if (!c0 || !c1) { this.overlay.classList.add('hidden'); return; }

        const roiW = c1.x - c0.x, roiH = c1.y - c0.y;
        if (roiW < 15 || roiH < 15) {
            this.overlay.classList.add('hidden');
            UIController.updateStatus("La selección es demasiado pequeña. Dibuja un recuadro más grande.", "warn");
            return;
        }

        this.roi = { x: Math.round(c0.x), y: Math.round(c0.y), w: Math.round(roiW), h: Math.round(roiH) };
        this.useCheck.disabled = false;
        this.useCheck.checked = true;
        this.drawMode = false;
        this.modeBtn.setAttribute('aria-pressed', 'false');
        this.modeBtn.classList.remove('btn--primary');
        UIController.dispatchProcessing();
    }
};

/* -------------------------------------------------------------------------
 * Geolocalización
 * ---------------------------------------------------------------------- */
const GPSManager = {
    telemetry: null,

    getPrecision() {
        const value = parseInt(el('gpsPrecision').value, 10);
        return isFinite(value) ? value : 3;
    },

    requestLocation() {
        const display = el('metadataDisplay');

        if (!navigator.geolocation) {
            display.textContent = "Este navegador no puede obtener la ubicación.";
            return;
        }

        display.textContent = "Obteniendo coordenadas…";

        navigator.geolocation.getCurrentPosition(
            (position) => {
                this.telemetry = {
                    lat: position.coords.latitude,
                    lon: position.coords.longitude,
                    accuracy: position.coords.accuracy
                };
                this.refreshDisplay();
            },
            // Antes no había callback de error: si se denegaba el permiso o
            // no había señal, el cuadro se quedaba en "Esperando coordenadas..."
            // para siempre.
            (err) => {
                this.telemetry = null;
                if (err.code === err.PERMISSION_DENIED) {
                    display.textContent = "Permiso de ubicación denegado. Actívalo en los ajustes del navegador si quieres registrar las coordenadas.";
                } else if (err.code === err.TIMEOUT) {
                    display.textContent = "El GPS está tardando demasiado. Prueba a salir al exterior y vuelve a marcar la casilla.";
                } else {
                    display.textContent = "No se pudo obtener la ubicación en este momento.";
                }
            },
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
        );
    },

    refreshDisplay() {
        if (!this.telemetry) return;
        const p = this.getPrecision();
        el('metadataDisplay').textContent =
            `GPS: LAT ${this.telemetry.lat.toFixed(p)}, LON ${this.telemetry.lon.toFixed(p)}` +
            (this.telemetry.accuracy ? ` (±${Math.round(this.telemetry.accuracy)} m del sensor)` : '');
    },

    getRoundedCoords() {
        if (!this.telemetry) return null;
        const p = this.getPrecision();
        return {
            latitude: parseFloat(this.telemetry.lat.toFixed(p)),
            longitude: parseFloat(this.telemetry.lon.toFixed(p)),
            decimalPlaces: p
        };
    }
};

/* -------------------------------------------------------------------------
 * Coordinación con el worker
 * ---------------------------------------------------------------------- */
const ProcessingController = {
    worker: null,
    imageVersion: 0,
    busy: false,
    pending: null,
    exportJobs: new Map(),
    nextJobId: 1,

    init() {
        if (location.protocol === 'file:') {
            UIController.showFatalError(
                "ArqueoStretch tiene que abrirse desde un servidor web, no haciendo doble clic en el archivo.",
                "Los navegadores no permiten que una página abierta con file:// use procesos en segundo plano ni la cámara. " +
                "Súbela a GitHub Pages, o ábrela en local con un servidor sencillo (por ejemplo, ejecutando «python3 -m http.server» en la carpeta del proyecto y entrando en http://localhost:8000)."
            );
            return false;
        }

        try {
            if (this.worker) this.worker.terminate();
            this.worker = new Worker('worker.js');
        } catch (err) {
            UIController.showFatalError(
                "No se pudo iniciar el procesador de imagen.",
                "Comprueba que el archivo worker.js está en la misma carpeta que index.html y que la página se sirve por http:// o https://."
            );
            return false;
        }

        this.worker.onmessage = (e) => this.handleResponse(e);
        this.worker.onerror = () => {
            this.busy = false;
            this.pending = null;
            this.exportJobs.forEach(job => job.reject(new Error("el procesador de imagen falló")));
            this.exportJobs.clear();
            UIController.updateStatus("El procesador de imagen ha fallado. Recarga la página si vuelve a ocurrir.", "error");
        };
        return true;
    },

    dispatch(originalData, filterValue, targetStd, roi) {
        if (!originalData || !this.worker) return;

        // Los filtros de GPU no pasan por el worker.
        if (filterValue === 'dog' || filterValue === 'unsharp_mask') {
            UIController.currentProcessedData = originalData;
            WebGL2Pipeline.invalidateTexture();
            UIController.requestWebGLRender();
            if (UIController.isLabMode) HistogramController.draw(UIController.currentProcessedData);
            UIController.updateStatus("Listo", "ok");
            return;
        }

        // Coalescencia: si ya hay un cálculo en marcha, se guarda solo la
        // petición más reciente en vez de encolarlas todas. Mover el slider
        // generaba decenas de recálculos completos por segundo.
        if (this.busy) {
            this.pending = { originalData, filterValue, targetStd, roi };
            return;
        }

        this.busy = true;
        UIController.updateStatus("Calculando", "busy");

        const bufferCopy = new Uint8ClampedArray(originalData.data.length);
        bufferCopy.set(originalData.data);

        this.worker.postMessage({
            imgData: { width: originalData.width, height: originalData.height, data: bufferCopy },
            filter: filterValue,
            targetStd: targetStd,
            version: this.imageVersion,
            roi: roi || null
        }, [bufferCopy.buffer]);
    },

    /**
     * Lanza la exportación a resolución completa. El worker decodifica el
     * archivo original, lo recorre por bandas y devuelve un PNG ya montado.
     * La interfaz sigue respondiendo durante todo el proceso.
     */
    exportFullResolution(job) {
        return new Promise((resolve, reject) => {
            if (!this.worker) { reject(new Error("el procesador de imagen no está disponible")); return; }
            const jobId = this.nextJobId++;
            this.exportJobs.set(jobId, { resolve, reject });
            this.worker.postMessage({ type: 'export', jobId, ...job });
        });
    },

    handleExportMessage(data) {
        const job = this.exportJobs.get(data.jobId);

        if (data.type === 'export-progress') {
            let msg = "Preparando la exportación";
            if (data.stage === 'procesando') msg = `Exportando, ${Math.round(data.progress * 100)} %`;
            else if (data.stage === 'comprimiendo') msg = "Comprimiendo el archivo";

            UIController.updateStatus(msg, "busy");
            // Sin duración: en modo campo el panel de datos está oculto y
            // este aviso es lo único que informa de que algo está pasando.
            Toast.show(msg, "info", 0);
            return;
        }

        if (!job) return;
        this.exportJobs.delete(data.jobId);
        Toast.hide();
        if (data.error) job.reject(new Error(data.error));
        else job.resolve(data.blob);
    },

    handleResponse(e) {
        if (e.data && (e.data.type === 'export' || e.data.type === 'export-progress')) {
            this.handleExportMessage(e.data);
            return;
        }

        if (e.data && e.data.type === 'shape') {
            ShapeExtractor.handleWorkerMessage(e.data);
            return;
        }

        this.busy = false;

        const runPending = () => {
            if (!this.pending) return;
            const job = this.pending;
            this.pending = null;
            this.dispatch(job.originalData, job.filterValue, job.targetStd, job.roi);
        };

        // Resultado de una imagen anterior: se descarta.
        if (e.data.version !== this.imageVersion) { runPending(); return; }

        if (e.data.error) {
            UIController.updateStatus("No se pudo procesar la imagen: " + e.data.error, "error");
            runPending();
            return;
        }

        if (!UIController.currentOriginalData) { runPending(); return; }

        const w = UIController.currentOriginalData.width;
        const h = UIController.currentOriginalData.height;

        UIController.currentProcessedData = new ImageData(e.data.dstUint8, w, h);
        // Las constantes derivadas (medias, matriz y límites del estiramiento)
        // se guardan para reutilizarlas tal cual en la exportación a
        // resolución completa: así el archivo es exactamente lo que se ve.
        UIController.currentConstants = e.data.constants || null;
        WebGL2Pipeline.invalidateTexture();
        UIController.updateStatus("Listo", "ok");

        if (!UIController.isHoldingOriginal) {
            UIController.requestWebGLRender();
            if (UIController.isLabMode) HistogramController.draw(UIController.currentProcessedData);
        }

        runPending();
    }
};

/* -------------------------------------------------------------------------
 * Exportación
 *
 * Dos caminos distintos:
 *
 *  - PNG: lo escribe el worker byte a byte, recorriendo el archivo original
 *    por bandas. No pasa por ningún <canvas>, que es lo que impone el techo
 *    de tamaño en los navegadores. Sin canvas no hay límite de área.
 *
 *  - JPEG: no hay forma razonable de escribirlo a mano (transformada del
 *    coseno, cuantización, Huffman), así que sigue usando el canvas y
 *    hereda su límite. Cuando la imagen no cabe, se dice claramente.
 * ---------------------------------------------------------------------- */
const ExportManager = {
    exporting: false,

    getFileName(extension) {
        let baseName = el('exportProjectName').value.trim();
        if (!baseName) {
            const now = new Date();
            const pad = num => String(num).padStart(2, '0');
            const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
            baseName = `${dateStr}_${UIController.getActiveFilter().toUpperCase()}`;
        }
        // Se descomponen los acentos antes de filtrar, para que "Peña Escrita"
        // sea "Pena_Escrita" y no "Pe_a_Escrita".
        return baseName
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9_\-]/g, '_')
            .replace(/_{2,}/g, '_')
            .slice(0, 120) + '.' + extension;
    },

    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = filename;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    },

    /**
     * Comprueba si el navegador puede manejar un lienzo de ese tamaño.
     * En vez de dar por buena una cifra fija —que envejece: Safari de iOS
     * pasó de 16,7 a 67 millones de píxeles en iOS 18— se prueba de verdad
     * y se mira si el resultado se puede leer.
     */
    canvasCanHandle(w, h) {
        if (w <= 0 || h <= 0) return false;
        try {
            const probe = document.createElement('canvas');
            probe.width = w;
            probe.height = h;
            const ctx = probe.getContext('2d');
            if (!ctx) return false;
            ctx.fillStyle = '#010203';
            ctx.fillRect(w - 1, h - 1, 1, 1);
            const px = ctx.getImageData(w - 1, h - 1, 1, 1).data;
            const ok = (px[0] === 1 && px[1] === 2 && px[2] === 3);
            probe.width = probe.height = 0;
            return ok;
        } catch (err) {
            return false;
        }
    },

    async exportDocument() {
        if (this.exporting) {
            UIController.updateStatus("Ya hay una exportación en marcha.", "warn");
            return;
        }
        if (!UIController.currentOriginalData || !UIController.sourceBlob) {
            UIController.updateStatus("No hay ninguna imagen cargada todavía.", "warn");
            return;
        }

        const exportImg = el('exportImgCheck').checked;
        const exportJson = el('exportJsonCheck').checked;

        if (!exportImg && !exportJson) {
            UIController.updateStatus("Marca al menos una casilla: imagen o parámetros.", "warn");
            return;
        }

        this.exporting = true;
        el('saveBtn').disabled = true;

        try {
            if (exportImg) await this.exportImage();
            if (exportJson) this.exportParameters();
            UIController.updateStatus("Exportado", "ok", { toast: true });
        } catch (err) {
            UIController.updateStatus("No se pudo completar la exportación: " + (err.message || err), "error");
        } finally {
            this.exporting = false;
            el('saveBtn').disabled = false;
        }
    },

    async exportImage() {
        const mode = el('exportFormatSelect').value;
        const mimeType = el('formatSelect').value;

        if (mimeType === 'image/jpeg') return this.exportJpeg(mode);
        return this.exportPng(mode);
    },

    // --- PNG a resolución completa, sin canvas y sin techo de tamaño ---
    async exportPng(mode) {
        const filter = UIController.getActiveFilter();
        const params = UIController.getRenderParams();
        const src = UIController.sourceSize;
        const estructural = (filter === 'dog' || filter === 'unsharp_mask');

        // Los filtros de color necesitan las constantes que calcula el
        // worker; los estructurales no. Si aún no han llegado, es que el
        // procesado no ha terminado.
        if (!estructural && !UIController.currentConstants) {
            throw new Error("el análisis todavía no ha terminado, espera un momento y vuelve a intentarlo");
        }

        UIController.updateStatus(`Exportando a ${src.width} × ${src.height} px`, "busy", { toast: true });

        const blob = await ProcessingController.exportFullResolution({
            blob: UIController.sourceBlob,
            constants: UIController.currentConstants,
            kind: filter,
            amount: params.filterAmount,
            levels: params.levels,
            previewWidth: UIController.currentOriginalData.width,
            mode: mode
        });

        this.downloadBlob(blob, this.getFileName('png'));
    },

    // --- JPEG: sigue atado al canvas ---
    async exportJpeg(mode) {
        const W = UIController.sourceSize.width;
        const H = UIController.sourceSize.height;
        const outW = (mode === 'combined') ? W * 2 : W;

        if (!this.canvasCanHandle(outW, H)) {
            throw new Error(
                `este navegador no puede generar un JPEG de ${outW} × ${H} px. ` +
                `Elige PNG, que no tiene ese límite, o reduce el tamaño de salida`
            );
        }

        // Se reutiliza el camino del worker para obtener los píxeles ya
        // procesados a resolución completa, y solo se usa el canvas para
        // recodificar a JPEG.
        const pngBlob = await this.exportPngBlob(mode);
        const bitmap = await createImageBitmap(pngBlob);

        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.98));
        canvas.width = canvas.height = 0;

        if (!blob) throw new Error("el navegador no pudo generar el JPEG");
        this.downloadBlob(blob, this.getFileName('jpg'));
    },

    async exportPngBlob(mode) {
        const filter = UIController.getActiveFilter();
        const params = UIController.getRenderParams();
        return ProcessingController.exportFullResolution({
            blob: UIController.sourceBlob,
            constants: UIController.currentConstants,
            kind: filter,
            amount: params.filterAmount,
            levels: params.levels,
            previewWidth: UIController.currentOriginalData.width,
            mode: mode
        });
    },

    exportParameters() {
        const config = UIController.getActiveConfig();
        const k = UIController.currentConstants;

        const metadata = {
            software: "ArqueoStretch",
            version: APP_VERSION,
            processing: {
                algorithm: config.filter,
                intensityPercent: config.percent,
                targetStd: config.intensity,
                levels: { black: config.black, gamma: config.gamma, white: config.white }
            },
            date: new Date().toISOString()
        };

        // Las constantes exactas que se aplicaron. Con ellas, el resultado
        // es reproducible píxel a píxel por cualquiera, aunque cambie la
        // versión del programa o el muestreo estadístico.
        if (k) {
            metadata.derivedConstants = {
                means: k.m,
                matrix: k.M,
                stretchLow: k.lo,
                stretchRange: k.range
            };
        }

        if (UIController.sourceSize) {
            metadata.image = {
                sourceWidth: UIController.sourceSize.width,
                sourceHeight: UIController.sourceSize.height,
                previewWidth: UIController.currentOriginalData ? UIController.currentOriginalData.width : null,
                previewHeight: UIController.currentOriginalData ? UIController.currentOriginalData.height : null,
                note: "Las constantes se estiman sobre la previsualización y se aplican a la resolución completa."
            };
        }

        const activeRoi = RoiSelector.getActiveRoi();
        if (activeRoi) metadata.processing.regionOfInterest = activeRoi;

        if (el('geoAuthCheck').checked) {
            const coords = GPSManager.getRoundedCoords();
            metadata.geolocation = coords || { note: "Solicitadas por el usuario, pero no disponibles al exportar." };
        }

        const blob = new Blob([JSON.stringify(metadata, null, 4)], { type: "application/json" });
        this.downloadBlob(blob, this.getFileName('json'));
    }
};

/* -------------------------------------------------------------------------
 * Extracción de forma (pintura vs. soporte)
 *
 * En vez de un calco binario, se clasifica cada píxel de forma continua
 * (0-1): cuánto se parece a la pintura frente al soporte, en el espacio ya
 * descorrelacionado por PCA, según los dos grupos que encuentra k-medias.
 * El umbral para una silueta o un contorno es una elección de quien
 * exporta, no una frontera que decida el algoritmo, y por eso se aplica
 * siempre al final, nunca dentro de la clasificación en sí. Ver el manual
 * técnico en la interfaz para la referencia bibliográfica.
 * ---------------------------------------------------------------------- */
const ShapeExtractor = {
    shapeConstants: null,
    probability: null,   // Uint8Array a resolución de previsualización, 0-255
    width: 0,
    height: 0,
    computing: false,
    threshold: 0.5,

    init() {
        el('calcShapeBtn').addEventListener('click', () => this.compute());
        el('shapeOverlayToggle').addEventListener('change', (e) => this.setOverlayVisible(e.target.checked));
        el('shapeThreshold').addEventListener('input', () => this.onThresholdChange());
        el('exportShapeProbBtn').addEventListener('click', () => this.exportProbability());
        el('exportShapeSilhouetteBtn').addEventListener('click', () => this.exportSilhouette());
        el('exportShapeContourBtn').addEventListener('click', () => this.exportContour());
        this.onThresholdChange();
    },

    reset() {
        this.shapeConstants = null;
        this.probability = null;
        this.width = 0;
        this.height = 0;
        this.computing = false;
        el('calcShapeBtn').disabled = false;
        el('shapeStatus').textContent = "Todavía no se ha calculado ninguna clasificación para esta imagen.";
        el('shapeOverlayToggle').checked = false;
        el('shapeOverlayToggle').disabled = true;
        ['exportShapeProbBtn', 'exportShapeSilhouetteBtn', 'exportShapeContourBtn'].forEach(id => { el(id).disabled = true; });
        this.setOverlayVisible(false);
    },

    compute() {
        if (!UIController.currentOriginalData || !ProcessingController.worker) {
            UIController.updateStatus("Carga primero una imagen.", "warn");
            return;
        }
        if (this.computing) return;
        this.computing = true;
        el('calcShapeBtn').disabled = true;
        UIController.updateStatus("Clasificando pintura y soporte", "busy");

        const originalData = UIController.currentOriginalData;
        const bufferCopy = new Uint8ClampedArray(originalData.data.length);
        bufferCopy.set(originalData.data);

        ProcessingController.worker.postMessage({
            type: 'shape',
            imgData: { width: originalData.width, height: originalData.height, data: bufferCopy },
            roi: RoiSelector.getActiveRoi(),
            version: ProcessingController.imageVersion
        }, [bufferCopy.buffer]);
    },

    handleWorkerMessage(data) {
        this.computing = false;
        el('calcShapeBtn').disabled = false;

        if (data.error) {
            UIController.updateStatus("No se pudo clasificar la imagen: " + data.error, "error");
            return;
        }
        // Resultado de una imagen o resolución ya descartada.
        if (data.version !== ProcessingController.imageVersion) return;

        this.shapeConstants = data.shapeConstants;
        this.probability = data.probability;
        this.width = data.width;
        this.height = data.height;

        const total = this.shapeConstants.nTotal || 1;
        const pctPintura = Math.round(100 * this.shapeConstants.nPintura / total);
        el('shapeStatus').textContent =
            `Clasificación lista. En la muestra usada, un ${pctPintura} % se agrupó como pintura y el resto como soporte. ` +
            `Revísalo con el mapa de probabilidad antes de fiarte del umbral: en encuadres muy cerrados sobre el motivo, los dos grupos pueden salir invertidos.`;

        ['exportShapeProbBtn', 'exportShapeSilhouetteBtn', 'exportShapeContourBtn'].forEach(id => { el(id).disabled = false; });
        el('shapeOverlayToggle').disabled = false;
        el('shapeOverlayToggle').checked = true;
        this.setOverlayVisible(true);
        UIController.updateStatus("Listo", "ok");
    },

    onThresholdChange() {
        const pct = parseInt(el('shapeThreshold').value, 10) || 50;
        this.threshold = pct / 100;
        el('shapeThresholdValue').textContent = pct + ' %';
        if (this.probability && !el('shapeOverlayCanvas').classList.contains('hidden')) this.drawOverlay();
    },

    setOverlayVisible(visible) {
        const canvas = el('shapeOverlayCanvas');
        if (visible && this.probability) {
            this.drawOverlay();
            canvas.classList.remove('hidden');
        } else {
            canvas.classList.add('hidden');
        }
    },

    /**
     * Dibuja el mapa de calor sobre un lienzo transparente colocado encima
     * del visor (hereda el encaje del resto de capas de .stage__inner). Los
     * píxeles por encima del umbral elegido se resaltan más: es una guía
     * visual para decidir el corte, no una frontera que imponga el propio
     * mapa.
     */
    drawOverlay() {
        const canvas = el('shapeOverlayCanvas');
        if (!this.probability || !this.width || !this.height) return;
        canvas.width = this.width;
        canvas.height = this.height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(this.width, this.height);
        const out = imgData.data;
        const prob = this.probability;
        const t = Math.round(this.threshold * 255);

        for (let i = 0; i < prob.length; i++) {
            const p = prob[i];
            const d = i * 4;
            out[d] = 98; out[d + 1] = 201; out[d + 2] = 191; // mismo acento cian de la interfaz
            out[d + 3] = (p >= t) ? Math.round(90 + (p / 255) * 140) : Math.round((p / 255) * 55);
        }
        ctx.putImageData(imgData, 0, 0);
    },

    suffixedFileName(extension, suffix) {
        const full = ExportManager.getFileName(extension);
        return full.replace(new RegExp('\\.' + extension + '$'), '_' + suffix + '.' + extension);
    },

    async exportProbability() {
        if (!this.shapeConstants || !UIController.sourceBlob) return;
        try {
            UIController.updateStatus("Exportando el mapa de probabilidad", "busy", { toast: true });
            const blob = await ProcessingController.exportFullResolution({
                blob: UIController.sourceBlob,
                kind: 'shape_probability',
                shapeConstants: this.shapeConstants
            });
            ExportManager.downloadBlob(blob, this.suffixedFileName('png', 'probabilidad'));
            UIController.updateStatus("Exportado", "ok", { toast: true });
        } catch (err) {
            UIController.updateStatus("No se pudo exportar el mapa de probabilidad: " + (err.message || err), "error");
        }
    },

    async exportSilhouette() {
        if (!this.shapeConstants || !UIController.sourceBlob) return;
        try {
            UIController.updateStatus("Exportando la silueta recortada", "busy", { toast: true });
            const blob = await ProcessingController.exportFullResolution({
                blob: UIController.sourceBlob,
                kind: 'shape_silhouette',
                shapeConstants: this.shapeConstants,
                shapeThreshold: this.threshold
            });
            ExportManager.downloadBlob(blob, this.suffixedFileName('png', 'silueta'));
            UIController.updateStatus("Exportado", "ok", { toast: true });
        } catch (err) {
            UIController.updateStatus("No se pudo exportar la silueta: " + (err.message || err), "error");
        }
    },

    /**
     * Contorno vectorial (marching squares) sobre el mapa ya calculado, a la
     * resolución de la vista previa: para un calco de referencia no hace
     * falta precisión submilimétrica, y así se evita trazar cientos de
     * millones de celdas en el propio navegador. Si hace falta más detalle,
     * sube la resolución de trabajo en el panel «Vista previa» y vuelve a
     * calcular la clasificación antes de exportar el contorno.
     */
    exportContour() {
        if (!this.probability || !this.width || !this.height) return;
        try {
            const svg = this.traceContourSvg(this.threshold);
            const blob = new Blob([svg], { type: 'image/svg+xml' });
            ExportManager.downloadBlob(blob, this.suffixedFileName('svg', 'contorno'));
        } catch (err) {
            UIController.updateStatus("No se pudo generar el contorno: " + (err.message || err), "error");
        }
    },

    /**
     * Marching squares clásico de 16 casos con interpolación en los bordes
     * de celda. Los segmentos no se cosen en un único trazado: cada uno se
     * escribe como un subtrazado "M...L..." independiente. El SVG resultante
     * es igual de válido y de preciso; un programa de vectores como
     * Illustrator o Inkscape puede unir los segmentos con su propia
     * herramienta si se necesita una sola línea continua.
     */
    traceContourSvg(threshold) {
        const w = this.width, h = this.height, prob = this.probability;
        const t = threshold * 255;
        const val = (x, y) => prob[y * w + x];

        const interp = (v0, v1, x0, y0, x1, y1) => {
            const denom = v1 - v0;
            const f = Math.abs(denom) > 1e-6 ? (t - v0) / denom : 0.5;
            const c = Math.max(0, Math.min(1, f));
            return [x0 + (x1 - x0) * c, y0 + (y1 - y0) * c];
        };

        const parts = [];
        for (let y = 0; y < h - 1; y++) {
            for (let x = 0; x < w - 1; x++) {
                const a = val(x, y), b = val(x + 1, y), c = val(x + 1, y + 1), d = val(x, y + 1);
                const ca = a >= t ? 1 : 0, cb = b >= t ? 1 : 0, cc = c >= t ? 1 : 0, cd = d >= t ? 1 : 0;
                const caseIdx = (ca << 3) | (cb << 2) | (cc << 1) | cd;
                if (caseIdx === 0 || caseIdx === 15) continue;

                const top = () => interp(a, b, x, y, x + 1, y);
                const right = () => interp(b, c, x + 1, y, x + 1, y + 1);
                const bottom = () => interp(d, c, x, y + 1, x + 1, y + 1);
                const left = () => interp(a, d, x, y, x, y + 1);

                const seg = (p1, p2) => {
                    parts.push(`M${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`);
                };

                switch (caseIdx) {
                    case 1: seg(left(), bottom()); break;
                    case 2: seg(bottom(), right()); break;
                    case 3: seg(left(), right()); break;
                    case 4: seg(top(), right()); break;
                    case 5: seg(top(), left()); seg(bottom(), right()); break;
                    case 6: seg(top(), bottom()); break;
                    case 7: seg(top(), left()); break;
                    case 8: seg(top(), left()); break;
                    case 9: seg(top(), bottom()); break;
                    case 10: seg(top(), right()); seg(left(), bottom()); break;
                    case 11: seg(top(), right()); break;
                    case 12: seg(left(), right()); break;
                    case 13: seg(bottom(), right()); break;
                    case 14: seg(left(), bottom()); break;
                }
            }
        }

        return '<?xml version="1.0" encoding="UTF-8"?>\n' +
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n` +
            `<path d="${parts.join(' ')}" fill="none" stroke="#000000" stroke-width="1" stroke-linecap="round"/>\n` +
            `</svg>\n`;
    }
};

/* -------------------------------------------------------------------------
 * Controlador principal de la interfaz
 * ---------------------------------------------------------------------- */
const UIController = {
    currentOriginalData: null,
    currentProcessedData: null,
    currentAlgMode: 'pca_rgb',
    isLabMode: false,
    isHoldingOriginal: false,
    offscreenCanvas: null,
    sourceSize: null,
    sourceBlob: null,
    currentConstants: null,
    reloadingSameImage: false,
    intensityTimer: null,

    QUALITY_KEY: 'arqueostretch_preview_quality',

    QUALITY_LEVELS: {
        baja:        1200000,
        equilibrada: 2500000,
        alta:        5000000,
        maxima:      12000000
    },

    /**
     * Elige un valor por defecto razonable la primera vez. No hay forma
     * fiable de medir la potencia de un dispositivo desde el navegador, así
     * que se combinan las pistas disponibles y se peca de prudente: siempre
     * se puede subir a mano, y una vista lenta da peor impresión que una
     * vista algo menos nítida.
     */
    detectDefaultQuality() {
        const memoria = navigator.deviceMemory || 0;        // solo lo da Chrome
        const nucleos = navigator.hardwareConcurrency || 0;
        const densidad = window.devicePixelRatio || 1;
        const esTactil = window.matchMedia('(pointer: coarse)').matches;

        if (!esTactil) {
            return (nucleos >= 8 || memoria >= 8) ? 'alta' : 'equilibrada';
        }

        // Safari no expone deviceMemory, así que en iPhone hay que juzgar por
        // otras pistas. Una pantalla de alta densidad es buena señal: los
        // aparatos con dpr 3 son de gama alta o media-alta reciente.
        const modesto = (memoria > 0 && memoria < 4) || nucleos <= 2 || densidad < 2;
        return modesto ? 'baja' : 'equilibrada';
    },

    getPreviewQuality() {
        let guardada = null;
        try { guardada = localStorage.getItem(this.QUALITY_KEY); } catch (err) { /* modo privado */ }
        if (guardada && this.QUALITY_LEVELS[guardada]) return guardada;
        return this.detectDefaultQuality();
    },

    setPreviewQuality(nivel) {
        if (!this.QUALITY_LEVELS[nivel]) return;
        try { localStorage.setItem(this.QUALITY_KEY, nivel); } catch (err) { /* modo privado */ }
    },

    /**
     * RESOLUCIÓN DE TRABAJO
     *
     * Lo que se ve en pantalla es una previsualización: la pantalla no tiene
     * más de dos o tres millones de píxeles, así que procesar más para
     * mostrarlo no aporta nada y sí gasta memoria y tiempo.
     *
     * Esto NO limita la calidad. Al exportar, las constantes calculadas
     * aquí se aplican al archivo original a resolución completa, por bandas,
     * dentro del worker. Es como trabaja Lightroom: la vista y el
     * histograma salen de una previsualización, y la exportación aplica las
     * matemáticas al archivo original.
     */
    get PREVIEW_MAX_PIXELS() {
        return this.QUALITY_LEVELS[this.getPreviewQuality()];
    },

    // La intensidad se guarda como valor efectivo del algoritmo (igual que en
    // versiones anteriores) para que los códigos ASW1 y las bibliotecas ya
    // guardadas sigan funcionando.
    /**
     * PRESETS
     *
     * Cada uno lleva la muestra del pigmento al que apunta. La muestra no es
     * decoración: dice a qué familia de color va dirigido el realce, que es
     * justo lo que el usuario necesita saber para elegir. Sustituye a los
     * emojis, que se dibujan distinto en cada sistema operativo y compiten
     * con los colores de la propia fotografía.
     *
     * La intensidad se guarda como valor efectivo del algoritmo (igual que en
     * versiones anteriores) para que los códigos ASW1 y las bibliotecas ya
     * guardadas sigan funcionando.
     */
    presetOrder: [
        'rojo_oxido', 'rojo_degradado', 'amarillo_tenue', 'negro_carbon',
        'superposicion_colores', 'grabados_relieve', 'textura_erosionada', 'alto_contraste'
    ],

    presets: {
        rojo_oxido: {
            filter: 'yre', intensity: 15, black: 0, gamma: 100, white: 255,
            name: 'Rojo óxido, hematita tenue', short: 'Rojo óxido',
            swatch: '#9e3b26'
        },
        rojo_degradado: {
            filter: 'ybr', intensity: 15, black: 0, gamma: 100, white: 255,
            name: 'Rojo lavado o degradado', short: 'Rojo lavado',
            swatch: '#b57a68'
        },
        amarillo_tenue: {
            filter: 'yds', intensity: 15, black: 0, gamma: 100, white: 255,
            name: 'Amarillo, ocre o calcita velada', short: 'Amarillo',
            swatch: '#c9a03f'
        },
        negro_carbon: {
            filter: 'ybk', intensity: 15, black: 0, gamma: 100, white: 255,
            name: 'Carbón vegetal o negro desvaído', short: 'Carbón',
            swatch: '#35343a'
        },
        superposicion_colores: {
            filter: 'lab', intensity: 15, black: 0, gamma: 100, white: 255,
            name: 'Varias capas superpuestas', short: 'Capas',
            swatch: 'linear-gradient(135deg, #9e3b26 0 34%, #c9a03f 34% 67%, #35343a 67%)'
        },
        grabados_relieve: {
            filter: 'dog', intensity: 130, black: 0, gamma: 100, white: 255,
            name: 'Grabados e incisiones', short: 'Grabados',
            swatch: '#8c8377'
        },
        textura_erosionada: {
            filter: 'unsharp_mask', intensity: 180, black: 10, gamma: 105, white: 245,
            name: 'Textura erosionada, contorno difuso', short: 'Erosionado',
            swatch: '#6f7a80'
        },
        alto_contraste: {
            filter: 'crgb', intensity: 15, black: 10, gamma: 95, white: 245,
            name: 'Luz dura y sombra profunda', short: 'Contraste',
            swatch: 'linear-gradient(135deg, #efe6cd 0 50%, #2a2a2f 50%)'
        }
    },

    init() {
        el('versionLabel').textContent = 'v' + APP_VERSION;

        try {
            WebGL2Pipeline.init(el('canvasView'));
        } catch (err) {
            this.showFatalError("ArqueoStretch no puede arrancar en este navegador.", err.message);
            return;
        }

        if (!ProcessingController.init()) return;

        FavoritesManager.load();
        this.renderPresetOptions();
        this.renderPresetButtonGrid();
        this.renderCleanPresetChips();
        ZoomController.init();
        ResizerController.init();
        RoiSelector.init();
        ShapeExtractor.init();
        this.setupEventListeners();
        this.switchUIMode(false);
        this.offscreenCanvas = document.createElement('canvas');

        // La cámara ya no se enciende sola: al arrancar no hay nada que ver,
        // así que se explica qué hacer.
        el('previewQuality').value = this.getPreviewQuality();
        this.updatePreviewReadout(0, 0);

        el('videoPreview').classList.add('hidden');
        Toast.show("Abre una imagen o usa la cámara para empezar.", "info", 0);
        this.updateStatus("Listo", "ok");

        if (window.innerWidth <= 600) {
            document.body.classList.add('clean-screen');
        }
    },

    showFatalError(title, detail) {
        const notice = document.createElement('div');
        notice.className = 'fatal';
        const h = document.createElement('h2');
        h.textContent = title;
        const p = document.createElement('p');
        p.textContent = detail || '';
        notice.appendChild(h);
        notice.appendChild(p);

        const container = el('mainContainer');
        if (container && container.parentNode) {
            container.parentNode.insertBefore(notice, container);
        } else {
            document.body.appendChild(notice);
        }
        this.updateStatus(title, "error");
    },

    /* ---------------- Configuración activa y validación ---------------- */

    getActiveFilter() {
        return this.isLabMode ? el('filterSelect').value : this.currentAlgMode;
    },

    getActiveConfig() {
        const filter = this.getActiveFilter();
        const percent = parseFloat(el('intensitySlider').value);
        return {
            filter,
            percent: Math.round(percent),
            intensity: Math.round(percentToValue(percent, filter) * 100) / 100,
            black: parseFloat(el('sliderBlack').value),
            gamma: parseFloat(el('sliderGamma').value),
            white: parseFloat(el('sliderWhite').value)
        };
    },

    /**
     * Punto único de entrada para cualquier configuración que venga de fuera:
     * códigos ASW1, favoritos de localStorage y JSON importados.
     * Antes cada camino asignaba los valores a los controles sin comprobar
     * nada, y un algoritmo inexistente producía una imagen de basura en
     * silencio.
     */
    applyConfigObject(cfg) {
        if (!cfg || typeof cfg !== 'object') {
            this.updateStatus("La configuración recibida no es válida.", "error");
            return false;
        }

        const filter = cfg.filter || cfg.algorithm;
        if (!VALID_FILTERS.includes(filter)) {
            this.updateStatus("Esa configuración usa un algoritmo que esta versión no reconoce.", "error");
            return false;
        }

        const levels = (cfg.levels && typeof cfg.levels === 'object') ? cfg.levels : cfg;

        // Se acepta tanto el porcentaje nuevo como el valor efectivo antiguo.
        let percent;
        if (isFinite(parseFloat(cfg.intensityPercent))) {
            percent = clampToSlider('intensitySlider', cfg.intensityPercent, 30);
        } else {
            const raw = parseFloat(cfg.intensity != null ? cfg.intensity : cfg.targetStd);
            percent = isFinite(raw) ? valueToPercent(raw, filter) : 30;
        }

        this.currentAlgMode = filter;
        if (this.isLabMode) el('filterSelect').value = filter;

        el('intensitySlider').value = Math.round(percent);
        el('sliderBlack').value = clampToSlider('sliderBlack', levels.black, 0);
        el('sliderGamma').value = clampToSlider('sliderGamma', levels.gamma, 100);
        el('sliderWhite').value = clampToSlider('sliderWhite', levels.white, 255);

        this.updateLevelLabels();
        this.updateInterfaceLabels();
        this.syncPresetUI();
        this.dispatchProcessing();
        return true;
    },

    /* ---------------- Modos y etiquetas ---------------- */

    switchUIMode(toLab) {
        this.isLabMode = toLab;
        document.body.classList.toggle('pro-mode-active', toLab);

        const tabSimple = el('tabSimple');
        const tabPro = el('tabProfesional');
        const manualBtn = el('toggleManualBtn');
        const manualPanel = el('manualPanel');

        tabSimple.classList.toggle('active', !toLab);
        tabPro.classList.toggle('active', toLab);
        tabSimple.setAttribute('aria-selected', String(!toLab));
        tabPro.setAttribute('aria-selected', String(toLab));

        if (toLab) {
            el('wrapperSimple').classList.add('hidden');
            manualBtn.classList.remove('hidden');
            el('filterSelect').value = this.currentAlgMode;
            if (this.currentProcessedData) HistogramController.draw(this.currentProcessedData);
        } else {
            el('wrapperSimple').classList.remove('hidden');
            manualBtn.classList.add('hidden');
            manualPanel.classList.add('hidden');
            manualBtn.setAttribute('aria-expanded', 'false');
            this.applyPresetValues();
        }
        this.updateInterfaceLabels();
    },

    updateInterfaceLabels() {
        const filterValue = this.getActiveFilter();
        const isColorSpaceAlgorithm = (filterValue !== 'dog' && filterValue !== 'unsharp_mask');

        el('labelIntensity').textContent = isColorSpaceAlgorithm
            ? "Intensidad del estiramiento PCA"
            : "Intensidad del filtro seleccionado";

        el('pcaHelpText').classList.toggle('hidden', !isColorSpaceAlgorithm);
        el('roiControlGroup').classList.toggle('hidden', !isColorSpaceAlgorithm);

        this.updateIntensityLabel();
    },

    updateIntensityLabel() {
        el('valIntensity').textContent = `${Math.round(parseFloat(el('intensitySlider').value))} %`;
        paintRange('intensitySlider');
    },

    applyPresetValues(presetKey) {
        // Sin clave explícita (al volver a modo simple) el modo profesional
        // manda y no se toca nada. Con clave explícita —una pastilla de la
        // barra limpia, por ejemplo— se aplica siempre.
        if (!presetKey && this.isLabMode) return;

        const pKey = presetKey || el('presetSelect').value;
        const config = this.presets[pKey];
        if (!config) return;

        el('presetSelect').value = pKey;
        this.currentAlgMode = config.filter;
        if (this.isLabMode) el('filterSelect').value = config.filter;

        el('intensitySlider').value = Math.round(valueToPercent(config.intensity, config.filter));
        el('sliderBlack').value = config.black;
        el('sliderGamma').value = config.gamma;
        el('sliderWhite').value = config.white;

        this.updateLevelLabels();
        this.updateInterfaceLabels();
        this.syncPresetUI();
        this.dispatchProcessing();
    },

    generateShareableCode() {
        const config = this.getActiveConfig();
        try {
            const payload = {
                v: APP_VERSION,
                filter: config.filter,
                intensity: config.intensity,
                intensityPercent: config.percent,
                black: config.black,
                gamma: config.gamma,
                white: config.white
            };
            el('shareCodeField').value = "ASW1:" + btoa(JSON.stringify(payload));
            this.updateStatus("Código generado. Cópialo para compartirlo.", "ok", { toast: true });
        } catch (err) {
            this.updateStatus("No se pudo generar el código.", "error");
        }
    },

    applyShareableCode() {
        const raw = el('shareCodeField').value.trim();
        if (!raw.startsWith("ASW1:")) {
            Dialog.alert(
                "El código que has pegado no empieza por «ASW1:», así que no es un código de configuración de ArqueoStretch.",
                "Código no reconocido"
            );
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(atob(raw.slice(5)));
        } catch (err) {
            Dialog.alert(
                "El código está incompleto o se ha copiado mal. Asegúrate de pegarlo entero, sin espacios ni saltos de línea de más.",
                "Código dañado"
            );
            return;
        }
        if (this.applyConfigObject(parsed)) {
            this.updateStatus("Código aplicado correctamente.", "ok", { toast: true });
        }
    },

    // El desplegable se construye desde la misma lista que las muestras, para
    // que no haya dos fuentes de verdad que se puedan desincronizar.
    renderPresetOptions() {
        const select = el('presetSelect');
        select.textContent = '';
        this.presetOrder.forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = this.presets[id].name;
            select.appendChild(opt);
        });
        select.value = this.presetOrder[0];
    },

    // Botón con muestra de pigmento + nombre.
    buildPigmentButton(id, className, useShortName) {
        const preset = this.presets[id];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = className;
        btn.dataset.value = id;
        btn.setAttribute('aria-label', preset.name);

        const swatch = document.createElement('span');
        swatch.className = className === 'chip' ? 'chip__swatch' : 'pigment__swatch';
        swatch.style.background = preset.swatch;
        btn.appendChild(swatch);

        const label = document.createElement('span');
        if (className !== 'chip') label.className = 'pigment__name';
        label.textContent = useShortName ? preset.short : preset.name;
        btn.appendChild(label);

        btn.addEventListener('click', () => this.applyPresetValues(id));
        return btn;
    },

    renderPresetButtonGrid() {
        const grid = el('presetButtonGrid');
        grid.textContent = '';
        this.presetOrder.forEach(id => {
            grid.appendChild(this.buildPigmentButton(id, 'pigment', false));
        });
    },

    renderCleanPresetChips() {
        const strip = el('cleanPresetsScroll');
        strip.textContent = '';
        this.presetOrder.forEach(id => {
            strip.appendChild(this.buildPigmentButton(id, 'chip', true));
        });
    },

    syncPresetUI() {
        const val = el('presetSelect').value;
        [el('presetButtonGrid'), el('cleanPresetsScroll')].forEach(parent => {
            if (!parent) return;
            Array.from(parent.children).forEach(node => {
                node.classList.toggle('active', node.dataset.value === val);
            });
        });
    },

    /* ---------------- Eventos ---------------- */

    setupEventListeners() {
        el('tabSimple').addEventListener('click', () => this.switchUIMode(false));
        el('tabProfesional').addEventListener('click', () => this.switchUIMode(true));
        el('presetSelect').addEventListener('change', (e) => this.applyPresetValues(e.target.value));

        // --- Manual técnico (antes no se podía ni abrir ni cerrar) ---
        el('toggleManualBtn').addEventListener('click', () => {
            const panel = el('manualPanel');
            const abierto = panel.classList.toggle('hidden') === false;
            el('toggleManualBtn').setAttribute('aria-expanded', String(abierto));
        });
        el('closeManualBtn').addEventListener('click', () => {
            el('manualPanel').classList.add('hidden');
            el('toggleManualBtn').setAttribute('aria-expanded', 'false');
            el('toggleManualBtn').focus();
        });

        // --- Biblioteca de configuraciones (antes ninguno de estos
        //     controles tenía evento: la sección entera era decorativa) ---
        el('saveFavBtn').addEventListener('click', () => FavoritesManager.saveActive());
        el('deleteFavBtnSimple').addEventListener('click', () => FavoritesManager.deleteSelected('favSelectSimple'));
        el('deleteFavBtnPro').addEventListener('click', () => FavoritesManager.deleteSelected('favSelectPro'));

        ['favSelectSimple', 'favSelectPro'].forEach(id => {
            el(id).addEventListener('change', (e) => {
                if (!e.target.value) return;
                FavoritesManager.loadConfig(e.target.value);
                // Mantiene los dos desplegables sincronizados.
                const otro = id === 'favSelectSimple' ? el('favSelectPro') : el('favSelectSimple');
                if (otro) otro.value = e.target.value;
            });
        });

        el('exportLibraryBtn').addEventListener('click', () => FavoritesManager.exportLibrary());
        el('importLibraryInput').addEventListener('change', (e) => {
            const file = e.target.files[0];
            e.target.value = '';
            FavoritesManager.importLibrary(file);
        });

        el('importJsonInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            e.target.value = '';
            if (!file) return;
            try {
                const data = JSON.parse(await file.text());
                const cfg = (data && data.processing) ? data.processing : data;
                if (this.applyConfigObject(cfg)) {
                    this.updateStatus("Parámetros cargados desde el archivo.", "ok", { toast: true });
                }
            } catch (err) {
                this.updateStatus("No se pudo leer el archivo de parámetros.", "error");
            }
        });

        // --- Códigos compartibles ---
        el('btnGenerateCode').addEventListener('click', () => this.generateShareableCode());
        el('btnApplyCode').addEventListener('click', () => this.applyShareableCode());
        el('btnCopyCode').addEventListener('click', async () => {
            const field = el('shareCodeField');
            if (!field.value) { this.updateStatus("No hay ningún código que copiar.", "warn"); return; }
            try {
                await navigator.clipboard.writeText(field.value);
                this.updateStatus("Código copiado al portapapeles.", "ok", { toast: true });
            } catch (err) {
                field.select();
                this.updateStatus("Selecciona y copia el código manualmente.", "warn");
            }
        });

        // --- Carga de imágenes ---
        const handleFileUpload = async (e) => {
            const file = e.target.files[0];
            // Resetear el valor permite volver a elegir el MISMO archivo:
            // antes el evento change no se disparaba la segunda vez.
            e.target.value = '';
            if (!file) return;

            this.updateStatus("Abriendo", "busy");
            try {
                const { bitmap, telemetry } = await ImageLoader.processUploadedFile(file);
                el('telSize').textContent = telemetry.size;
                // El propio archivo se guarda como fuente: pesa lo que pesa
                // comprimido, no lo que ocuparía descomprimido, y permite
                // exportar a resolución completa sin retener la imagen entera.
                this.loadBitmapIntoPipeline(bitmap, file);
            } catch (err) {
                this.updateStatus(err.message, "error");
            }
        };

        el('uploadInput').addEventListener('change', handleFileUpload);
        el('uploadInputClean').addEventListener('change', handleFileUpload);

        el('captureBtn').addEventListener('click', async () => {
            const video = el('videoPreview');

            if (!CameraController.isActive) {
                const ok = await CameraController.ensure();
                if (!ok) return;
                // El botón dice lo que hace en cada momento, en vez de pedir
                // al usuario que recuerde que el primer toque no captura.
                el('captureBtnLabel').textContent = 'Capturar';
                Toast.show("Cámara activa. Pulsa Capturar cuando lo tengas encuadrado.", "ok", 5000);
                return;
            }

            if (video.videoWidth === 0) {
                this.updateStatus("La cámara todavía se está iniciando. Prueba otra vez en un segundo.", "warn");
                return;
            }

            const shot = document.createElement('canvas');
            shot.width = video.videoWidth;
            shot.height = video.videoHeight;
            shot.getContext('2d').drawImage(video, 0, 0);

            // La captura se congela en un PNG para tener una fuente estable
            // que exportar después a resolución completa.
            const snapBlob = await new Promise(r => shot.toBlob(r, 'image/png'));
            const bitmap = await createImageBitmap(shot);
            shot.width = shot.height = 0;

            el('telSize').textContent = snapBlob
                ? `${(snapBlob.size / (1024 * 1024)).toFixed(2)} MB`
                : '—';
            this.loadBitmapIntoPipeline(bitmap, snapBlob);
        });

        // --- Sliders ---
        ['sliderBlack', 'sliderGamma', 'sliderWhite'].forEach(id => {
            el(id).addEventListener('input', () => { this.updateLevelLabels(); this.requestWebGLRender(); });
        });

        el('filterSelect').addEventListener('change', (e) => {
            this.currentAlgMode = e.target.value;
            this.updateInterfaceLabels();
            this.dispatchProcessing();
        });

        // La etiqueta se actualiza al instante; el recálculo espera a que el
        // usuario deje de arrastrar.
        el('intensitySlider').addEventListener('input', () => {
            this.updateIntensityLabel();
            clearTimeout(this.intensityTimer);
            this.intensityTimer = setTimeout(() => this.dispatchProcessing(), 120);
        });

        // --- Ver el original manteniendo pulsado ---
        let touchStartY = 0;

        const marcarComparando = (activo) => {
            ['holdViewBtn', 'cleanHoldViewBtn'].forEach(id => {
                const btn = el(id);
                if (btn) btn.classList.toggle('is-holding', activo);
            });
        };

        const startHold = (e) => {
            if (!this.currentOriginalData) return;
            if (e.type === 'touchstart') touchStartY = e.touches[0].clientY;
            this.isHoldingOriginal = true;
            marcarComparando(true);
            WebGL2Pipeline.invalidateTexture();
            WebGL2Pipeline.render(this.currentOriginalData, 0, { black: 0, gamma: 1.0, white: 255 }, 0);
        };

        const moveHold = (e) => {
            if (!this.isHoldingOriginal) return;
            if (e.type === 'touchmove' && Math.abs(e.touches[0].clientY - touchStartY) > 8) endHold();
        };

        const endHold = () => {
            if (!this.isHoldingOriginal) return;
            this.isHoldingOriginal = false;
            marcarComparando(false);
            WebGL2Pipeline.invalidateTexture();
            this.requestWebGLRender();
        };

        ['holdViewBtn', 'cleanHoldViewBtn'].forEach(id => {
            const btn = el(id);
            if (!btn) return;
            btn.addEventListener('contextmenu', (e) => e.preventDefault());
            btn.addEventListener('mousedown', startHold);
            btn.addEventListener('mouseup', endHold);
            btn.addEventListener('mouseleave', endHold);
            btn.addEventListener('touchstart', startHold, { passive: true });
            btn.addEventListener('touchmove', moveHold, { passive: true });
            btn.addEventListener('touchend', endHold, { passive: true });
            btn.addEventListener('touchcancel', endHold, { passive: true });
            btn.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); startHold(e); }
            });
            btn.addEventListener('keyup', (e) => {
                if (e.key === 'Enter' || e.key === ' ') endHold();
            });
            btn.addEventListener('blur', endHold);
        });

        // --- Pantalla limpia ---
        el('cleanScreenBtn').addEventListener('click', () => {
            document.body.classList.add('clean-screen');
            this.requestWebGLRender();
        });
        el('restoreScreenBtn').addEventListener('click', () => {
            document.body.classList.remove('clean-screen');
            this.requestWebGLRender();
        });

        // --- GPS ---
        el('geoAuthCheck').addEventListener('change', async (e) => {
            if (!e.target.checked) {
                ['gpsPrecisionRow', 'gpsPrivacyNote', 'metadataDisplay', 'btnCopyGPS']
                    .forEach(id => el(id).classList.add('hidden'));
                return;
            }

            const ok = await Dialog.confirm(
                "Tu ubicación se usará solo para guardarla dentro del archivo .json que exportes. " +
                "No se envía a ningún servidor: todo el procesamiento ocurre en tu dispositivo.\n\n" +
                "¿Quieres continuar?",
                "Registrar coordenadas"
            );

            if (!ok) { e.target.checked = false; return; }

            ['gpsPrecisionRow', 'gpsPrivacyNote', 'metadataDisplay', 'btnCopyGPS']
                .forEach(id => el(id).classList.remove('hidden'));

            // Las coordenadas solo viajan en el .json, así que se activa esa
            // casilla: antes se podía marcar GPS, exportar un PNG y perder el
            // dato de campo sin ningún aviso.
            if (!el('exportJsonCheck').checked) {
                el('exportJsonCheck').checked = true;
                this.updateStatus("Se ha activado también «Exportar parámetros (.json)»: las coordenadas se guardan ahí.", "warn");
            }

            GPSManager.requestLocation();
        });

        el('gpsPrecision').addEventListener('change', () => GPSManager.refreshDisplay());

        el('previewQuality').addEventListener('change', (e) => {
            this.setPreviewQuality(e.target.value);
            this.reloadPreview();
        });

        el('btnCopyGPS').addEventListener('click', async () => {
            const coords = GPSManager.getRoundedCoords();
            if (!coords) { this.updateStatus("Aún no hay coordenadas disponibles.", "warn"); return; }
            const text = `${coords.latitude}, ${coords.longitude}`;
            try {
                await navigator.clipboard.writeText(text);
                this.updateStatus("Coordenadas copiadas al portapapeles.", "ok", { toast: true });
            } catch (err) {
                this.updateStatus("No se pudieron copiar automáticamente: " + text, "warn");
            }
        });

        // --- Exportación ---
        el('saveBtn').addEventListener('click', () => ExportManager.exportDocument());
        el('cleanExportBtn').addEventListener('click', () => ExportManager.exportDocument());

        // Libera la cámara al cerrar o al pasar la app a segundo plano.
        window.addEventListener('pagehide', () => CameraController.stop());
    },

    /* ---------------- Pipeline ---------------- */

    loadBitmapIntoPipeline(bitmap, sourceBlob) {
        const srcW = bitmap.width;
        const srcH = bitmap.height;
        this.sourceSize = { width: srcW, height: srcH };
        this.sourceBlob = sourceBlob || null;

        // La previsualización se reduce a la resolución de trabajo. El
        // archivo original se conserva intacto para la exportación.
        let w = srcW, h = srcH;
        let esPrevia = false;
        const objetivo = this.PREVIEW_MAX_PIXELS;

        if (w * h > objetivo) {
            const factor = Math.sqrt(objetivo / (w * h));
            w = Math.max(1, Math.floor(w * factor));
            h = Math.max(1, Math.floor(h * factor));
            esPrevia = true;
        }

        // Segundo tope, por lado y no por área: la previsualización se sube a
        // la GPU como una textura, y ninguna dimensión puede pasar del máximo
        // que admita el aparato. Una panorámica muy alargada puede tener pocos
        // megapíxeles y aun así ser demasiado ancha.
        const maxLado = WebGL2Pipeline.maxTextureSize || 4096;
        if (w > maxLado || h > maxLado) {
            const f = Math.min(maxLado / w, maxLado / h);
            w = Math.max(1, Math.floor(w * f));
            h = Math.max(1, Math.floor(h * f));
            esPrevia = true;
        }

        ProcessingController.imageVersion++;
        ProcessingController.pending = null;
        this.currentProcessedData = null;
        this.currentConstants = null;
        this.isHoldingOriginal = false;
        ShapeExtractor.reset();

        // Al recargar la MISMA imagen con otra resolución de trabajo, la
        // selección sigue siendo válida: solo hay que reescalar sus
        // coordenadas. Al cargar una imagen distinta, se descarta.
        const roiPrevio = (this.reloadingSameImage && RoiSelector.roi && this.currentOriginalData)
            ? { roi: RoiSelector.roi, escala: w / this.currentOriginalData.width,
                activa: RoiSelector.useCheck.checked }
            : null;

        RoiSelector.clear(true);
        ZoomController.reset();
        if (!this.reloadingSameImage) CameraController.stop();

        const glCanvas = el('canvasView');
        glCanvas.width = w;
        glCanvas.height = h;

        const viewerCard = el('viewerCard');
        viewerCard.style.aspectRatio = `${w} / ${h}`;
        viewerCard.style.height = '';
        viewerCard.style.maxHeight = '';

        this.offscreenCanvas.width = w;
        this.offscreenCanvas.height = h;
        const ctx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, w, h);

        this.currentOriginalData = ctx.getImageData(0, 0, w, h);

        const mpx = (srcW * srcH / 1000000).toFixed(1);
        el('telResolution').textContent = `${srcW} × ${srcH} (${mpx} Mpx)`;

        el('videoPreview').classList.add('hidden');
        glCanvas.classList.remove('hidden');

        WebGL2Pipeline.invalidateTexture();
        WebGL2Pipeline.render(this.currentOriginalData, 0, { black: 0, gamma: 1.0, white: 255 }, 0);

        if (esPrevia && this.sourceBlob) {
            Toast.show(
                `Vista a ${w} × ${h} para ir rápido. Al exportar en PNG se usan los ${mpx} Mpx completos.`,
                "ok", 6000
            );
        } else if (esPrevia) {
            Toast.show(`Vista reducida a ${w} × ${h}.`, "warn", 6000);
        } else {
            Toast.hide();
        }

        if (roiPrevio) {
            RoiSelector.restoreScaled(roiPrevio.roi, roiPrevio.escala, roiPrevio.activa, w, h);
        }

        this.updatePreviewReadout(w, h);

        if (!this.isLabMode) this.applyPresetValues(); else this.dispatchProcessing();
        bitmap.close();
    },

    updatePreviewReadout(w, h) {
        const nodo = el('previewActual');
        if (!nodo) return;
        const src = this.sourceSize;
        if (!src) { nodo.textContent = '—'; return; }
        nodo.textContent = (w === src.width && h === src.height)
            ? `${w} × ${h}, completa`
            : `${w} × ${h}`;
    },

    /**
     * Vuelve a preparar la imagen actual con otra resolución de trabajo.
     * Se decodifica otra vez desde el archivo original, que es justo lo que
     * se conserva para poder exportar a resolución completa.
     */
    async reloadPreview() {
        if (!this.sourceBlob) {
            this.updatePreviewReadout(0, 0);
            return;
        }
        this.updateStatus("Cambiando la resolución de trabajo", "busy");
        try {
            const bitmap = await createImageBitmap(this.sourceBlob, { imageOrientation: 'from-image' });
            this.reloadingSameImage = true;
            this.loadBitmapIntoPipeline(bitmap, this.sourceBlob);
        } catch (err) {
            this.updateStatus("No se pudo volver a abrir la imagen con la nueva resolución.", "error");
        } finally {
            this.reloadingSameImage = false;
        }
    },

    dispatchProcessing() {
        if (!this.currentOriginalData) return;
        const filterValue = this.getActiveFilter();
        const targetStd = percentToValue(el('intensitySlider').value, filterValue);
        ProcessingController.dispatch(this.currentOriginalData, filterValue, targetStd, RoiSelector.getActiveRoi());
    },

    getRenderParams() {
        const filterValue = this.getActiveFilter();
        const targetStd = percentToValue(el('intensitySlider').value, filterValue);
        let glFilterMode = 0;
        if (filterValue === 'dog') glFilterMode = 1;
        else if (filterValue === 'unsharp_mask') glFilterMode = 2;

        return {
            glFilterMode,
            levels: {
                black: parseFloat(el('sliderBlack').value),
                gamma: parseFloat(el('sliderGamma').value) / 100.0,
                white: parseFloat(el('sliderWhite').value)
            },
            filterAmount: filterValue === 'dog' ? (targetStd / 5.0) : (targetStd / 45.0)
        };
    },

    requestWebGLRender() {
        if (!this.currentProcessedData || this.isHoldingOriginal) return;
        const p = this.getRenderParams();
        WebGL2Pipeline.render(this.currentProcessedData, p.glFilterMode, p.levels, p.filterAmount);
    },

    // Dibuja el resultado procesado ignorando el estado de "ver original".
    // Lo usa la exportación para no depender de qué se esté mostrando.
    renderProcessedToCanvas() {
        if (!this.currentProcessedData) return;
        const p = this.getRenderParams();
        WebGL2Pipeline.invalidateTexture();
        WebGL2Pipeline.render(this.currentProcessedData, p.glFilterMode, p.levels, p.filterAmount);
    },

    updateLevelLabels() {
        el('valBlack').textContent = el('sliderBlack').value;
        el('valGamma').textContent = (el('sliderGamma').value / 100.0).toFixed(2);
        el('valWhite').textContent = el('sliderWhite').value;
        ['sliderBlack', 'sliderGamma', 'sliderWhite'].forEach(paintRange);
        this.updateIntensityLabel();
    },

    /**
     * kind: 'ok' | 'warn' | 'error' | 'busy'
     * Los errores y avisos se muestran además sobre el visor, porque el panel
     * de telemetría está oculto en pantalla limpia.
     */
    updateStatus(msg, kind, opts) {
        const node = el('telStatus');
        if (node) node.textContent = msg;

        // El color lo decide el CSS a partir del atributo, no un estilo en
        // línea: así el punto indicador y el texto van siempre a juego.
        const readout = el('readout');
        if (readout) readout.dataset.kind = kind || 'ok';

        const debeAvisar = (opts && opts.toast) || kind === 'error' || kind === 'warn';
        if (debeAvisar) {
            Toast.show(msg, kind === 'busy' ? 'info' : kind, kind === 'error' ? 8000 : 5000);
        }
    }
};

/* -------------------------------------------------------------------------
 * Arranque
 * ---------------------------------------------------------------------- */
window.addEventListener('DOMContentLoaded', () => {
    UIController.init();

    // Funcionamiento sin conexión: imprescindible para trabajo de campo en
    // cuevas y abrigos, donde no hay cobertura.
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(() => { /* sin conexión offline, la app sigue funcionando */ });
    }
});
