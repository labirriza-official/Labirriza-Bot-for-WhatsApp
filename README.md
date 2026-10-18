# La Birriaza · Bot de pedidos por WhatsApp

Sistema completo para que los clientes de La Birriaza pidan por WhatsApp **solo tocando opciones**. Al confirmar, la **comanda se imprime sola en cocina** y el dueño ve sus **ventas en un panel web**.

```
 Cliente en WhatsApp ──► Meta (WhatsApp Cloud API) ──► Servidor en la nube (este proyecto)
                                                          │   ├─ Bot (botones y listas)
                                                          │   ├─ Base de datos (SQLite)
                                                          │   ├─ Panel de ventas  /panel
                                                          │   └─ Simulador        /simulador
                                                          ▼
                              PC del restaurante: agente de impresión ──► Impresora térmica (red, puerto 9100)
```

## Qué hace

**Bot (WhatsApp)**
- Saludo con botones: *Hacer pedido · Ver promociones · Hablar con alguien*.
- Menú en lista, cantidades del 1 al 10 y bebidas en una sublista.
- Después de cada producto: *Agregar más · Modificar pedido · Continuar*. Para modificar: *Agregar una · Quitar una · Eliminar*.
- Recoger en el local o entrega a domicilio. Para domicilio, el cliente toca el botón nativo **Enviar ubicación** (o escribe su dirección) y puede dejar una referencia.
- Para domicilio, el bot pregunta **a qué número llamar cuando el repartidor llegue**. El cliente toca *Este mismo número* o escribe otro número de 10 dígitos (acepta formatos como +52 1 222 123 4567).
- El nombre se toma del perfil de WhatsApp y el cliente confirma con *Sí / Otro nombre*.
- Pago en **efectivo**: sugiere billetes ($200, $500…) y calcula el cambio. Pago por **transferencia**: manda la imagen con los datos de pago y pide la captura del comprobante.
- Al final muestra un resumen con *Confirmar · Modificar · Cancelar*.
- Si el cliente escribe en vez de tocar, el bot entiende textos como "quesabirria", "2" o "continuar". Si no entiende algo, repite la pregunta.
- Envío fijo o por zonas de distancia, con aviso cuando la ubicación queda fuera de la zona de entrega. Horario de atención configurable.
- *Hablar con alguien* pausa al bot 30 minutos para que una persona conteste desde WhatsApp Business.

**Comanda impresa**
- Logo, número de pedido grande, productos en letra doble, datos de entrega y totales.
- **Teléfono para llamar al llegar** en letra grande, además del número de WhatsApp.
- **Código QR** con las coordenadas exactas que mandó el cliente: abre Google Maps con el marcador en ese punto y vista satelital. Debajo del QR van impresas las coordenadas.
- Cambio a llevar (efectivo), o el aviso "Comprobante recibido – verificar depósito" (transferencia).
- Si la impresora está apagada, la comanda se reintenta sola y no se pierde.

**Panel de ventas** (`/panel`, protegido con contraseña)
- Ventas, pedidos, ticket promedio y porcentaje de pedidos completados por el bot, comparados contra el periodo anterior.
- Ventas por día u hora, forma de pago, tipo de entrega, productos más vendidos y horas pico.
- Embudo del bot: cuántos escriben, cuántos arman pedido y cuántos confirman.
- Lista de pedidos con su comanda, la ubicación, el comprobante, un botón para reimprimir y el cambio de estado. Al marcar *En camino* o *Listo*, el bot le avisa al cliente por WhatsApp.

**Simulador** (`/simulador`): sirve para probar todo desde el celular sin tener la cuenta de WhatsApp. Sus pedidos salen marcados como **PRUEBA**.

---

## 1. Probarlo en tu computadora (10 minutos)

Necesitas [Node.js 20 o superior](https://nodejs.org).

```bash
npm install
cp .env.example .env        # en Windows: copy .env.example .env
npm start
```

- Simulador del cliente: http://localhost:3000/simulador
- Panel de ventas: http://localhost:3000/panel (contraseña = `PANEL_PASSWORD` del `.env`)

En el panel, marca **Incluir pedidos de prueba** para ver los pedidos del simulador.

Pruebas automáticas: `npm test`

---

## 2. Conectar WhatsApp (API oficial de Meta)

Lo que necesitas tener:
1. Una **cuenta de Meta Business** (business.facebook.com) a nombre del restaurante.
2. Un **número de teléfono para el bot**. ⚠️ Ese número no puede estar usándose al mismo tiempo en la app normal de WhatsApp o en WhatsApp Business. Lo más fácil es un chip nuevo. También se puede migrar el número actual, pero entonces deja de funcionar en la app.

Pasos:
1. Entra a https://developers.facebook.com → **Mis apps → Crear app** → tipo **Empresa (Business)**.
2. En la app, agrega el producto **WhatsApp**. Meta te da un número de prueba para empezar.
3. En **WhatsApp → Configuración de la API** copia el **Phone number ID** a `WHATSAPP_PHONE_NUMBER_ID`.
4. Crea un **token permanente**: en el Business Manager ve a **Configuración → Usuarios del sistema → Agregar** (rol administrador) → **Generar token** con los permisos `whatsapp_business_messaging` y `whatsapp_business_management`. Pégalo en `WHATSAPP_TOKEN`. (El token temporal de la página de la API dura solo 24 horas.)
5. En **Configuración de la app → Básica** copia la **Clave secreta** a `WHATSAPP_APP_SECRET`.
6. En **WhatsApp → Configuración → Webhook**:
   - URL de devolución de llamada: `https://TU-DOMINIO/webhook`
   - Token de verificación: el mismo texto que pusiste en `WHATSAPP_VERIFY_TOKEN`
   - Suscríbete al campo **messages**.
7. Agrega el número real del restaurante en **WhatsApp → Configuración de la API → Agregar número** y verifícalo con un código SMS.

**Liga para que los clientes empiecen el pedido** (para redes sociales, un QR en las mesas o un volante):
```
https://wa.me/52XXXXXXXXXX?text=Hola%2C%20me%20gustar%C3%ADa%20hacer%20un%20pedido.
```

### Costo de WhatsApp
Desde el **1 de octubre de 2026**, Meta cobra también los mensajes que el bot manda al responder (los "mensajes de servicio"). Según los proveedores, cada número tiene **1,000 mensajes gratis al mes** y después se cobran a la tarifa de utilidad de México (unos **US$0.0085 por mensaje**). Confirma las tarifas vigentes en el panel de facturación de Meta.

Este bot manda entre **10 mensajes** (pedido sencillo) y **19 mensajes** (pedido a domicilio de 3 productos). Eso alcanza para unos 50 a 100 pedidos gratis al mes. Después cuesta alrededor de **US$0.10 a US$0.16 por pedido**. El código ya junta las notas en un solo mensaje para gastar menos.

---

## 3. Publicar el servidor en la nube (Railway)

WhatsApp necesita una dirección pública con HTTPS. Con Railway:

1. Sube este proyecto a un repositorio de GitHub (el `.gitignore` ya excluye `.env` y la base de datos).
2. En https://railway.app → **New Project → Deploy from GitHub repo**. Railway detecta el `Dockerfile`.
3. **Agrega un volumen** (Settings → Volumes) montado en `/data`. Sin el volumen, los pedidos se borran en cada actualización.
4. En **Variables**, copia todo lo de `.env.example` con tus valores. Usa `DATA_DIR=/data`.
5. En **Settings → Networking → Generate Domain** obtienes la URL. Ponla en `PUBLIC_URL` y úsala en el webhook de Meta.

También funciona en Render o en un VPS con Docker: `docker build -t birriaza . && docker run -d -p 3000:3000 -v birriaza-data:/data --env-file .env birriaza`.

---

## 4. Impresora de cocina y agente de impresión

Impresora del restaurante: **SPRT SP-POS8811** (80 mm, USB + red, corte automático, QR nativo). Funciona con la configuración por defecto (`TICKET_COLS=48`, `TICKET_QR_MODE=native`).

El agente corre en la **PC del restaurante con Windows** donde está conectada la impresora. Solo necesita [Node.js](https://nodejs.org) (versión LTS).

### Opción A: impresora por USB (la configuración actual)
1. Instala el **driver de la SP-POS8811** (viene en el CD o en la página de SPRT) y conecta la impresora por USB. Imprime una página de prueba desde Windows para confirmar.
2. Copia la carpeta `agent/` a la PC (por ejemplo a `C:\Birriaza\agent`).
3. Doble clic en **`ver-impresoras.bat`** y copia el nombre exacto de la impresora (columna *Name*).
4. Copia `config.ejemplo.json` como `config.json` y llénalo:
   ```json
   { "servidor": "https://TU-DOMINIO", "token": "igual a PRINT_AGENT_TOKEN", "conexion": "usb", "impresoraNombre": "NOMBRE EXACTO" }
   ```
5. Doble clic en **`probar-impresora.bat`**. Debe salir una hoja de prueba.
6. Doble clic en **`iniciar-agente.bat`** y deja la ventana abierta (se puede minimizar).
7. Para que arranque solo al prender la PC: `Win + R` → `shell:startup` → pega ahí un acceso directo a `iniciar-agente.bat`.

### Opción B: impresora por cable de red
Conecta el puerto de red de la impresora al módem, imprime su hoja de configuración (botón FEED al encenderla) para ver la IP y reserva esa IP en el módem. En `config.json` usa `"conexion": "red"` e `"impresoraIp": "192.168.x.x"`. Así la impresora no depende del cable USB.

El panel muestra en verde **Impresora en línea** cuando el agente está conectado. Si la PC se apaga, las comandas esperan en el servidor y se imprimen al volver a encenderla.

Si salen símbolos raros en los acentos, cambia `TICKET_CODEPAGE=none`.

---

## 5. Ajustes del día a día

| Qué | Dónde |
|---|---|
| Productos y precios | `menu.json` (se recarga solo, sin reiniciar) |
| Costo de envío y zonas | `ENVIO_COSTO`, `ENVIO_ZONAS`, `RESTAURANT_LAT/LNG` |
| Horario | `HORARIO=12:00-22:00` |
| Datos de transferencia | `PAGO_BANCO`, `PAGO_TITULAR`, `PAGO_CLABE` y la imagen `public/img/datos-pago.jpg` |
| Promociones | `PROMOCIONES` |
| Logo de la comanda | `assets/logo-raster.json` |

WhatsApp admite como máximo **10 opciones por lista** y nombres de **24 letras**. Si el menú pasa de 10 opciones, el bot muestra primero las categorías y cada una abre sus productos.

---

## Estructura

```
src/
  server.js            servidor web
  config.js            lee el .env
  menu.js / menu.json  menú
  db.js                base de datos SQLite (pedidos, sesiones, cola de impresión)
  stats.js             cálculos del panel
  bot/engine.js        flujo de la conversación
  bot/messages.js      botones, listas, imagen, ubicación (con los límites de WhatsApp)
  bot/pricing.js       subtotal, envío por zonas y billetes sugeridos
  whatsapp/cloud.js    conexión con la API de Meta
  printing/ticket.js   diseño de la comanda
  printing/escpos.js   comandos de la impresora
  routes/              webhook, panel, agente de impresión y simulador
public/panel           panel de ventas
public/simulador       simulador del chat
agent/                 agente de impresión para la PC del restaurante
test/                  pruebas automáticas
```

## Pendientes antes de lanzar
- Confirmar con el dueño el **costo de envío** (de ejemplo está en $20) y, si aplica, las zonas.
- Confirmar el **horario** y el **teléfono** para "Hablar con alguien".
- La transferencia **no se verifica automáticamente**: alguien debe revisar el depósito en Mercado Pago antes de enviar. La comanda lo recuerda.
- Hacer un respaldo periódico del archivo `birriaza.db` que está en el volumen `/data`.
