# ArqueoStretch

**Realce de pigmento y microrrelieve en fotografía de arte rupestre, directamente en el navegador.**

👉 **[arqueostretch.vercel.app](https://arqueostretch.vercel.app)**

Herramienta libre para documentación de pinturas y grabados rupestres. Aplica
estiramiento por descorrelación (*decorrelation stretch*) y filtros
estructurales para hacer visibles restos de pigmento que a simple vista se
confunden con el soporte.

**Tus fotos no salen de tu dispositivo.** No hay servidor, no hay cuenta, no hay
subida de archivos: todo el procesamiento ocurre en tu propio navegador. Se
puede instalar y funciona sin conexión, que es lo normal en una cueva.

---

## Índice

- [Para usarlo](#para-usarlo)
  - [Instalarlo en el móvil](#instalarlo-en-el-móvil)
  - [Cómo se usa](#cómo-se-usa)
  - [Qué algoritmo elegir](#qué-algoritmo-elegir)
  - [Resolución: qué ves y qué exportas](#resolución-qué-ves-y-qué-exportas)
  - [Exportación y reproducibilidad](#exportación-y-reproducibilidad)
  - [Coordenadas GPS: leer antes de compartir](#coordenadas-gps-leer-antes-de-compartir)
- [Para modificarlo](#para-modificarlo)
  - [Estructura del proyecto](#estructura-del-proyecto)
  - [Levantarlo en local](#levantarlo-en-local)
  - [Cómo funciona por dentro](#cómo-funciona-por-dentro)
  - [Reglas de diseño](#reglas-de-diseño)
  - [Antes de tocar nada](#antes-de-tocar-nada)
- [Créditos y licencia](#créditos-y-licencia)

---

# Para usarlo

## Instalarlo en el móvil

Se puede usar directamente desde el navegador, pero instalarlo tiene una ventaja
importante para trabajo de campo: **funciona sin cobertura**.

- **Android (Chrome):** menú ⋮ → *Añadir a pantalla de inicio*
- **iPhone (Safari):** botón compartir → *Añadir a pantalla de inicio*

La primera visita descarga la aplicación. A partir de ahí abre y funciona en
modo avión. Cuando vuelvas a tener conexión, se actualiza sola.

## Cómo se usa

1. **Abre una imagen** o usa la cámara.
2. **Elige el pigmento que buscas.** En modo simple cada preset lleva una
   muestra del color al que se ajusta el realce: rojo óxido, rojo lavado,
   amarillo, carbón, grabados, etc.
3. **Dibuja una zona de cálculo** (modo profesional). Si encuadras solo la
   pintura, el realce se ajusta a esos colores en lugar de al conjunto de la
   roca. Suele ser la diferencia entre ver un trazo y no verlo. Los píxeles
   quemados por el sol y los completamente negros se descartan solos.
4. **Ajusta la intensidad** con el control deslizante, de 0 a 100 %.
5. **Mantén pulsado «comparar»** para ver el original y volver.
6. **Exporta.**

**Pantalla limpia** oculta toda la interfaz y deja solo la imagen y la tira de
pigmentos. Es la vista para trabajar delante del panel.

## Qué algoritmo elegir

El modo simple ya elige por ti. Si trabajas en modo profesional:

| Algoritmo | Para qué |
|---|---|
| **YRE** | Rojos muy degradados. El más agresivo con la hematites lavada |
| **YBR** | Rojos en general |
| **YDS** | Uso general y amarillos |
| **YBK** | Negros y carbón desvaído |
| **LAB / LDS / LRE** | Equivalentes en espacio CIELAB. Mejor con sombras marcadas |
| **CRGB** | Matriz fija, sin PCA. Rápido y predecible para rojos |
| **PCA sRGB / YCbCr** | Estiramiento estándar, sin sesgo hacia un color concreto |
| **Diferencia de gaussianas** | Grabados, piqueteados e incisiones. Ignora el color |
| **Máscara de enfoque** | Microtextura y contornos difusos |

> ⚠️ **Los colores del resultado no son reales.** El estiramiento por
> descorrelación produce falso color: sirve para *ver* dónde hay pigmento, no
> para determinar de qué color es. En una publicación, acompaña siempre la
> imagen procesada del original y de los parámetros usados.

## Resolución: qué ves y qué exportas

Hay dos resoluciones distintas, y entender la diferencia evita malentendidos.

**Lo que ves en pantalla es una previsualización.** Tu pantalla no tiene más de
dos o tres millones de píxeles, así que procesar más para mostrarlo no aporta
nada y sí gasta memoria y batería. El indicador bajo la imagen muestra la
resolución del **original**.

**Al exportar en PNG se usa el archivo original entero**, a resolución completa.
Sin reducción de calidad y sin límite práctico de tamaño: hay exportaciones
verificadas de 100 megapíxeles usando 15 MB de memoria.

En el panel **Vista previa** puedes elegir la resolución de trabajo:

| Nivel | Píxeles | Cuándo |
|---|---|---|
| Rápida | 1,2 Mpx | Móviles antiguos, o cuando los controles van lentos |
| Equilibrada | 2,5 Mpx | Por defecto en la mayoría de móviles |
| Alta | 5 Mpx | Ordenador, o móvil potente |
| Máxima | 12 Mpx | Ordenador con memoria de sobra |

La aplicación elige un valor razonable la primera vez según tu dispositivo, y
recuerda el que pongas tú. **No afecta a la calidad de lo que exportas**, solo a
la nitidez al ampliar mucho y a la fluidez de los controles.

## Exportación y reproducibilidad

- **PNG**: resolución completa, sin pérdidas y sin límite de tamaño. Es la
  opción correcta para documentación.
- **JPEG**: más ligero, pero con pérdidas y con un tope de tamaño impuesto por
  el navegador. Si la imagen no cabe, la aplicación te avisa.
- **Comparativa lado a lado**: original y procesada en un solo archivo.
- **Parámetros (`.json`)**: incluye el algoritmo, la intensidad, los niveles y
  **las constantes exactas que se aplicaron** (medias, matriz 3×3 y límites del
  estiramiento). Con ese archivo tu resultado es reproducible píxel a píxel por
  cualquiera, aunque cambie la versión del programa. Expórtalo siempre que el
  material vaya a una publicación o a un informe.

También puedes generar un **código de configuración** (`ASW1:…`) para pasar los
mismos ajustes a otra persona por mensaje, y guardar configuraciones con nombre
en tu navegador.

## Coordenadas GPS: leer antes de compartir

Si activas la casilla, las coordenadas se guardan **solo dentro del `.json`**,
nunca en un servidor. Puedes elegir la precisión: exacta (~1 m), reducida
(~100 m, por defecto) o aproximada (~1 km).

> ⚠️ **La localización precisa de arte rupestre sin catalogar es información
> sensible frente al expolio.** Para material que vaya a salir del equipo de
> trabajo, usa precisión reducida o desactiva las coordenadas.

---

# Para modificarlo

Es un proyecto **sin dependencias, sin compilación y sin backend**. Son archivos
estáticos: se editan y ya está. No hay `npm install` ni `build`.

## Estructura del proyecto

| Archivo | Qué contiene |
|---|---|
| `index.html` | Estructura de la página y el juego de iconos SVG |
| `styles.css` | Todos los estilos, con las variables de diseño al principio |
| `app.js` | Interfaz, pipeline de GPU (WebGL2) y coordinación |
| `worker.js` | Los cálculos: PCA, Jacobi, CIELAB, procesado por bandas y codificador PNG |
| `sw.js` | Service worker: funcionamiento sin conexión |
| `manifest.json` | Datos para instalarla como aplicación |
| `favicon.svg`, `icon-*.png` | Iconos |

**Los archivos van todos en la raíz del repositorio.** Si mueves `worker.js` o
`styles.css` a subcarpetas, hay que actualizar las rutas en `app.js`,
`index.html` y `sw.js`.

## Levantarlo en local

**No funciona abriendo `index.html` con doble clic.** Los navegadores bloquean
los *web workers* y el acceso a la cámara en páginas servidas por `file://`. La
aplicación lo detecta y te lo dice, pero conviene saberlo.

Con Python instalado, desde la carpeta del proyecto:

```bash
python3 -m http.server 8000
```

Y entra en `http://localhost:8000`. Cualquier otro servidor estático vale
igual (`npx serve`, `php -S`, la extensión Live Server de VS Code…).

### Despliegue

El repositorio está conectado a Vercel: **cada cambio en `main` despliega
automáticamente** en [arqueostretch.vercel.app](https://arqueostretch.vercel.app).
No hay configuración de compilación porque no hace falta compilar nada.

Si actualizas archivos y no ves los cambios, es el service worker sirviendo la
versión en caché. Sube `CACHE_NAME` en `sw.js` (por ejemplo de
`arqueostretch-v0.6` a `v0.7`) para forzar la actualización.

### Requisitos del navegador

Hace falta **WebGL2**: Chrome, Firefox y Edge modernos, y Safari 15 o superior
(iOS 15+, de 2021). Si no está disponible, la aplicación lo dice con un mensaje
claro en vez de quedarse en negro.

## Cómo funciona por dentro

La idea central, y de la que salen casi todas las decisiones de arquitectura:

> El estiramiento por descorrelación es, para cada píxel, `salida = M · (entrada − media) + media`,
> donde `M` es una matriz 3×3 y `media` un vector, ambos calculados a partir de
> las estadísticas de la imagen. **Una vez conocidas esas constantes, cada píxel
> es independiente de los demás.**

De ahí:

1. **No hacen falta buffers intermedios.** Se lee un píxel, se transforma y se
   escribe. El worker no reserva ningún array del tamaño de la imagen.
2. **La imagen se puede procesar por bandas horizontales**, una cada vez, con
   memoria constante. Eso es lo que permite exportar 100 Mpx sin ahogarse.
3. **Las constantes se estiman sobre la previsualización y se reutilizan tal
   cual en la exportación.** No es un atajo: la covarianza es una estimación
   estadística y con dos millones de muestras el error sobre los autovectores
   está en el orden del 0,07 %. Y reutilizarlas garantiza que el archivo
   exportado sea exactamente lo que se vio en pantalla. Es como trabaja
   Lightroom: la vista y el histograma salen de una previsualización, y la
   exportación aplica las matemáticas al archivo original.

Los filtros estructurales (diferencia de gaussianas y máscara de enfoque) sí
dependen de los píxeles vecinos, así que las bandas se leen con un margen
vertical que se descarta después. Sus radios se escalan con la relación entre la
previsualización y el original; si no, el efecto saldría mucho más fino en la
exportación que en pantalla.

### El PNG está escrito a mano

`worker.js` genera el PNG byte a byte: firma, `IHDR`, bloques `IDAT`
comprimidos con `CompressionStream('deflate')`, filtro Paeth y `IEND`, con CRC32
propio.

No es por gusto. **El elemento `<canvas>` es lo que impone el techo de tamaño en
los navegadores**: Safari en iOS estuvo casi diez años limitado a 16,7 millones
de píxeles, y en iOS 18 subió a 67 millones. Sin canvas de por medio, ese techo
desaparece. El JPEG no se puede escribir a mano de forma razonable (DCT,
cuantización, Huffman), así que sigue pasando por el canvas y hereda su límite.

### Dónde está cada cosa

- **Añadir un algoritmo de color**: `spaceParams`, `forwardPixel` e
  `inversePixel` en `worker.js`, más la lista `VALID_FILTERS` en `app.js` y la
  opción en el `<select id="filterSelect">` de `index.html`.
- **Añadir un preset**: `presetOrder` y `presets` en `app.js`. Cada uno lleva
  `swatch` con el color de la muestra.
- **Cambiar la resolución de trabajo**: `QUALITY_LEVELS` en `app.js`.
- **Cambiar colores, tamaños o espaciado**: variables CSS al principio de
  `styles.css`.

## Reglas de diseño

Si vas a tocar el aspecto, estas reglas están ahí por un motivo:

- **El cromo es desaturado a propósito.** Una interfaz con color altera la
  percepción del pigmento que se está analizando. Es la razón por la que
  Lightroom y Capture One son grises. El color solo aparece donde el color es un
  dato: las muestras de pigmento de los presets.
- **El acento es cian, no ocre.** Un acento ocre competiría con los rojos de la
  propia roca. El cian es el color característico de una imagen estirada por
  descorrelación y da el máximo contraste frente al pigmento.
- **La imagen no lleva marco.** Ni borde, ni sombra, ni esquinas redondeadas.
- **Mayúsculas y espaciado de letras: solo en la familia monoespaciada**, que es
  la de etiquetas y lecturas numéricas.
- **Sin emojis.** Se dibujan distinto en cada sistema y compiten cromáticamente
  con la foto. Los iconos son SVG de trazo 1,6 dentro del bloque `<defs>` de
  `index.html`.

## Antes de tocar nada

Dos avisos de sitios donde es fácil romper algo sin darse cuenta:

**El orden del CSS importa en las reglas de modo.** La sección 23 de
`styles.css` (las anulaciones de pantalla limpia) va al final *a propósito*: hay
selectores de la sección 19 con la misma especificidad y también con
`!important`, y en un empate gana el que aparece después. Está explicado en un
comentario ahí mismo.

**Cambiar la aritmética del worker cambia resultados ya publicados.** Las
conversiones de `worker.js` incluyen redondeos que parecen sobrantes pero no lo
son: mantienen la compatibilidad con los códigos de configuración y los `.json`
exportados por versiones anteriores. Si modificas ahí, compara la salida píxel a
píxel contra la versión previa antes de subirlo.

---

# Créditos y licencia

El método y los espacios de color provienen de la investigación de
**Jon Harman, Ph.D.**, autor de [DStretch®](https://www.dstretch.com/), que
adaptó el estiramiento por descorrelación al arte rupestre. ArqueoStretch es una
implementación independiente para navegador, no afiliada a DStretch.

Si usas la herramienta en un trabajo publicado, cita el trabajo original de
Harman.
