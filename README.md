# Hamilton Mostrador: probador virtual en vivo

Tienda de ropa con probador virtual en vivo: el cliente enciende la cámara (celular o computadora) y se ve usando la prenda en tiempo real, gracias al modelo **Lucy VTON** de [Decart](https://platform.decart.ai).

- **Tienda** (`/`): productos, cuenta del cliente con correo y contraseña, compra de tiempo de probador (transferencia o WhatsApp) y probador en vivo.
- **Panel** (`/panel`): aprobar pagos, cargar tiempo a clientes, editar productos y fotos, precios de los paquetes, datos de pago y la clave de API de Decart.

Cada cliente solo puede usar el tiempo de su propia cuenta. La clave de Decart nunca llega al navegador: el servidor entrega tokens temporales que duran lo que le queda al pase del cliente.

## Requisitos

- Node.js 18 o más reciente. No hay dependencias que instalar.
- Una cuenta en [platform.decart.ai](https://platform.decart.ai) con su clave de API (`dct_...`).

## Uso en tu computadora

```bash
node server.mjs
```

- Tienda: http://localhost:5180
- Panel: http://localhost:5180/panel. La primera vez te pide crear el usuario de administrador.

## Celular

Los navegadores de celular **solo dan acceso a la cámara en sitios con `https://`**. Para usarlo en el celular, publícalo en un servicio con HTTPS.

### Publicar en Render (recomendado)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hamiltongranillo10/probador-virtual)

El archivo `render.yaml` ya trae todo configurado: plan Starter (unos $7 USD al mes) y un disco de 1 GB para los datos (unos $0.25 USD al mes). Render solo te pide escribir tu correo en `ADMIN_EMAIL`. Al terminar te da una dirección `https://...onrender.com`: entra a `/panel`, crea tu administrador con ese correo y pon la clave de Decart en Ajustes.

Variables de entorno al publicar:

| Variable | Para qué |
|---|---|
| `HOST=0.0.0.0` | Aceptar visitas desde internet |
| `PORT` | Lo pone el servicio de hosting |
| `ADMIN_EMAIL` | Tu correo: solo ese correo puede crear la cuenta del panel |
| `DECART_API_KEY` | Opcional: clave inicial. También se puede poner o cambiar desde el panel |
| `DATA_DIR` | Carpeta de datos (por defecto `data/`). En Render apunta al disco persistente |
| `COOKIE_SECURE=1` | Cookies solo por https |

Los datos (clientes, pagos, productos, ajustes y fotos subidas) se guardan en la carpeta `data/`. En el hosting, esa carpeta tiene que estar en un **disco persistente**; si no, se borran en cada reinicio.

## Costos

Decart cobra $0.02 USD por segundo de video generado (Lucy VTON 3.6, 720p). Los paquetes por defecto son $0.50 = 15 s y $1.00 = 35 s, y se cambian desde el panel.
