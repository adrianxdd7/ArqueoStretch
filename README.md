# ArqueoStretch

Herramienta libre para el realce y análisis de pinturas y grabados rupestres.
Funciona dentro del navegador: **las fotos no se suben a ningún servidor**, todo
el procesamiento ocurre en el propio dispositivo.

Los fundamentos metodológicos y los espacios de color están basados en las
investigaciones de Jon Harman desarrolladas en DStretch®.

---

## ⚠️ Importante: no funciona haciendo doble clic en el archivo

ArqueoStretch usa un *Web Worker* (para no congelar la interfaz mientras
calcula) y acceso a la cámara. Los navegadores **bloquean las dos cosas** en
páginas abiertas con `file://`, es decir, abriendo `index.html` directamente
desde el explorador de archivos.

Si lo haces, verás un aviso rojo explicándolo. Necesitas servirla por
`http://` o `https://`. Tienes tres opciones:

### Opción 1 — GitHub Pages (recomendada)

1. Sube todos los archivos a un repositorio de GitHub.
2. En el repositorio, ve a **Settings → Pages**.
3. En *Source* elige la rama `main` y la carpeta `/ (root)`. Guarda.
4. En un par de minutos tendrás la app en `https://TU-USUARIO.github.io/ArqueoStretch/`.

Es gratis, ya va por HTTPS (necesario para la cámara y el GPS) y permite
instalarla como aplicación en el móvil.

### Opción 2 — Servidor local para probar cambios

Con Python instalado, abre una terminal en la carpeta del proyecto y ejecuta:

```bash
python3 -m http.server 8000
```

Luego entra en `http://localhost:8000`. Para parar, `Ctrl + C`.

*(Nota: en `localhost` la cámara funciona, pero el GPS puede pedirte HTTPS
según el navegador.)*

### Opción 3 — Cualquier hosting estático

Netlify, Cloudflare Pages, Vercel o el hosting que ya uses. No hay backend ni
base de datos: son archivos estáticos y nada más.

---

## Instalarla en el móvil (funciona sin cobertura)

Una vez publicada por HTTPS, ArqueoStretch es una **PWA**: se puede instalar y
usar sin conexión, que es lo habitual en cuevas y abrigos.

- **Android (Chrome):** menú ⋮ → *Añadir a pantalla de inicio*.
- **iPhone (Safari):** botón compartir → *Añadir a pantalla de inicio*.

La primera visita descarga la app; a partir de ahí abre y funciona en modo
avión. Las actualizaciones se descargan sin más cuando hay conexión.

---

## Archivos del proyecto

| Archivo | Qué es |
|---|---|
| `index.html` | Estructura de la página (solo el marcado) |
| `styles.css` | Todos los estilos |
| `app.js` | Interfaz, pipeline de GPU (WebGL2) y coordinación |
| `worker.js` | Los cálculos pesados: PCA, Jacobi, LAB, CRGB, procesado por bandas y codificador PNG |
| `manifest.json` | Datos para instalarla como aplicación |
| `sw.js` | Service worker: funcionamiento sin conexión |
| `favicon.svg`, `icon-*.png` | Iconos: la espiral pasa de ocre a cian, que es la operación que hace la app |

**Los siete archivos tienen que estar en la misma carpeta.** Si mueves
`worker.js` o `styles.css` a subcarpetas, hay que actualizar las rutas en
`app.js`, `index.html` y `sw.js`.

---

## Requisitos del navegador

Hace falta **WebGL2**, disponible en Chrome, Firefox y Edge modernos y en
Safari 15 o superior (iOS 15+, 2021). En un navegador sin WebGL2 la app avisa
con un mensaje claro en vez de quedarse en negro.

---

## Sobre las coordenadas GPS

Si activas la casilla de coordenadas, se guardan **solo en el archivo `.json`**
que exportes, nunca en un servidor. Puedes elegir la precisión:

- Exacta (~1 m)
- Reducida (~100 m) — la opción por defecto
- Aproximada (~1 km)

**Ten cuidado al compartir.** La localización precisa de arte rupestre no
catalogado es información sensible frente al expolio. Para publicar o enviar
material fuera del equipo de trabajo, usa la precisión reducida o desactiva las
coordenadas.

---

## Resolución: qué se ve y qué se exporta

Hay dos resoluciones distintas y conviene entender la diferencia, porque es lo
que permite trabajar con fotos enormes sin que la aplicación se ahogue.

**Lo que ves en pantalla es una previsualización** de unos 2,5 megapíxeles. Tu
pantalla no tiene más píxeles que eso, así que procesar más para mostrarlo no
aportaría nada y sí gastaría memoria y tiempo. El indicador debajo de la imagen
muestra siempre la resolución del **original**, que es la que importa.

**Al exportar en PNG se usa el archivo original entero**, a resolución completa.
No hay reducción de calidad y no hay límite práctico de tamaño: se han
verificado exportaciones de 100 megapíxeles usando 15 MB de memoria y unos
9 segundos de proceso.

Esto funciona porque el estiramiento por descorrelación es una transformación
afín por píxel: una vez calculada la matriz, cada píxel es independiente de los
demás. Así que la matriz se estima sobre la previsualización —una estimación
estadística con dos millones de muestras tiene un error del orden del 0,07 %— y
luego se aplica al original recorriéndolo por bandas horizontales, una cada vez.
Es exactamente como trabaja Lightroom: la vista y el histograma salen de una
previsualización y la exportación aplica las matemáticas al archivo original.

Como efecto secundario útil, el `.json` exportado incluye ahora las constantes
exactas que se aplicaron (medias, matriz 3×3 y límites del estiramiento). Con
ellas el resultado es reproducible píxel a píxel por cualquiera, aunque cambie
la versión del programa.

### PNG sí, JPEG con matices

El PNG lo escribe la propia aplicación byte a byte, sin pasar por ningún
elemento `<canvas>`. Eso importa porque **el canvas es lo que impone el techo de
tamaño en los navegadores**: Safari en iOS estuvo casi diez años limitado a 16,7
millones de píxeles y en iOS 18 subió a 67 millones. Sin canvas, ese techo
desaparece.

El JPEG no se puede escribir a mano de forma razonable, así que sigue pasando
por el canvas y hereda su límite. Si la imagen no cabe, la aplicación te lo dice
y te propone PNG. Para documentación arqueológica el PNG es además la opción
correcta: sin pérdidas.

### Si quieres cambiar la resolución de trabajo

Está en `app.js`:

```js
PREVIEW_MAX_PIXELS: 2500000,
```

Subirlo hace la previsualización más nítida al ampliar mucho, pero más lenta al
mover los controles. No afecta a la calidad de lo que exportas.

---

## Nota de diseño

Si vas a cambiar el aspecto (tú o una IA), estas son las reglas del sistema. Están
ahí por un motivo, no por gusto:

**El cromo es desaturado a propósito.** Una interfaz con color altera la percepción
del pigmento que estás analizando. Es la razón por la que Lightroom y Capture One son
grises. El color solo aparece donde el color es un dato: las muestras de pigmento de
los presets.

**El acento es cian, no ocre.** Un acento ocre competiría con los rojos y ocres de la
propia roca. El cian es el color característico de una imagen estirada por
descorrelación, y da el máximo contraste frente al pigmento, así que nunca confundes
interfaz con imagen.

**La imagen no lleva marco.** Ni borde, ni sombra, ni esquinas redondeadas. La
separación entre imagen y controles se hace con el contraste de superficies.

**Mayúsculas y espaciado de letras: solo en monoespaciada.** Es la familia de
utilidad, para etiquetas y lecturas numéricas, como en un aparato de medida. En el
texto normal, nunca.

**Sin emojis.** Se dibujan distinto en cada sistema operativo y compiten
cromáticamente con la foto. Los iconos son SVG de trazo 1.6 en `index.html`, dentro
del bloque `<defs>`, y heredan el color del texto.

Los valores concretos (colores, tamaños, espaciado) están al principio de
`styles.css` como variables CSS. Cámbialos ahí y cambian en todas partes; no metas
colores ni tamaños sueltos por el archivo.

---

## Créditos

- **Jon Harman, Ph.D.** — creador del algoritmo de *decorrelation stretch*
  adaptado al arte rupestre (DStretch®).
