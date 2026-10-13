# Nanotap Loyalty

Tarjetas de lealtad digitales multi-negocio en **Apple Wallet** y **Google Wallet**, sin app para el cliente.
Implementa la especificación técnica v1.0 (`ESPECIFICACION-TECNICA.md`): léala junto con este README y el código.

- **Cliente final:** se inscribe en `/{slug}/inscripcion`, guarda la tarjeta en su wallet y consulta su saldo en `/{slug}/consulta`.
- **Staff:** entra en `/{slug}/staff`, escanea el QR con la cámara del navegador, suma sellos y canjea premios.
- **Operador:** en `/operador/` da de alta negocios, crea usuarios de staff, exporta CSV y atiende solicitudes de la Ley 8968.

Stack: Node.js 20+ · Express 5 · Supabase (Postgres) · passkit-generator · Google Wallet API · HTML/JS sin framework.

---

## 1. Puesta en marcha (Fase 0)

1. **Base de datos.** En Supabase → *SQL Editor*, pegue y ejecute [`src/db/schema.sql`](src/db/schema.sql). Se puede volver a ejecutar sin problema.
2. **Variables de entorno.** Copie `.env.example` a `.env` y complete al menos:
   `BASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API → *service_role*),
   `JWT_SECRET` (32+ caracteres aleatorios) y `OPERADOR_PASSWORD`. En local use `NODE_ENV=development`.
   Las variables `APPLE_*` y `GOOGLE_*` son opcionales: si faltan, ese botón de wallet simplemente no aparece.
3. **Instalar y arrancar:**
   ```bash
   npm install
   npm run seed:demo      # crea el negocio "demo" y el usuario de staff "demo" (imprime la contraseña)
   npm run dev            # http://localhost:3000
   ```
4. **Probar:** abra `http://localhost:3000/demo/inscripcion`, inscríbase, y en otra pestaña entre a
   `http://localhost:3000/demo/staff` para sumarse sellos con el código que aparece bajo el QR.

### Probar con el teléfono y con los wallets

Apple y Google necesitan llegar a su servidor por **HTTPS público** (Google descarga las imágenes de la
tarjeta, Apple llama al web service) y la cámara del teléfono solo funciona con HTTPS. En local use un túnel:

```bash
cloudflared tunnel --url http://localhost:3000     # o: ngrok http 3000
```

y ponga la URL que le da como `BASE_URL` (reinicie el servidor).

### Producción (Railway)

El sistema está publicado en Railway, proyecto `nanotap-loyalty`:
**https://nanotap-loyalty-production.up.railway.app**

- **Publicar cambios:** desde esta carpeta, `railway up --ci --service nanotap-loyalty`. Sube el código (respeta
  `.railwayignore`: nunca sube `.env` ni `certs/`), lo construye con Node 24 y lo reinicia.
- **Variables:** se administran en Railway (`railway variable set CLAVE --stdin --service nanotap-loyalty`), no
  desde el `.env` local. En producción `BASE_URL` es la dirección de Railway y `NODE_ENV=production`.
- **Logs:** `railway logs --service nanotap-loyalty`.
- **Pendiente:** Railway deja de leer `railway.json` el 2026-12-01. Antes de esa fecha, migrar con
  `railway config migrate --apply` y volver a agregar la regla de reinicio.
- No deje el servidor local corriendo con la misma base de datos: su worker podría actualizar tarjetas de Google
  con direcciones `localhost`.

---

## 2. Google Wallet (Fase 1)

1. Cree una cuenta de emisor en la [Google Pay & Wallet Console](https://pay.google.com/business/console) → *Google Wallet API*. Anote el **Issuer ID**.
2. En Google Cloud: cree un proyecto, habilite la **Google Wallet API**, cree una **cuenta de servicio** y descargue su llave JSON.
3. En la Wallet Console → *Users*, invite el correo de la cuenta de servicio con rol de desarrollador.
4. Variables:
   ```
   GOOGLE_WALLET_ISSUER_ID=3388000000000000000
   GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<el JSON en base64>
   ```
   Para sacar el base64: PowerShell `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cuenta.json"))` · bash `base64 -w0 cuenta.json`.

Mientras el emisor esté en modo demo, solo las cuentas de Google agregadas como *testers* pueden guardar tarjetas.
Para salir a producción hay que pedir acceso de publicación en la consola (Google revisa la marca de la clase).

Cada negocio es una `LoyaltyClass` (`<issuer>.negocio-<id>`) y cada cliente un `LoyaltyObject`
(`<issuer>.cliente-<id>`). Al sumar un sello se hace `patch` del objeto y Google actualiza el teléfono solo.

---

## 3. Apple Wallet (Fase 3)

Requiere la membresía del Apple Developer Program.

1. En *Certificates, Identifiers & Profiles* → *Identifiers* → cree un **Pass Type ID** (ej. `pass.cr.nanotap.loyalty`).
2. Cree el **certificado** de ese Pass Type ID (con un CSR desde *Acceso a Llaveros* o con openssl), descárguelo,
   impórtelo y expórtelo como `.p12`. Conviértalo a PEM:
   ```bash
   openssl pkcs12 -in pass.p12 -clcerts -nokeys -out certs/signerCert.pem -legacy
   openssl pkcs12 -in pass.p12 -nocerts -out certs/signerKey.pem -legacy    # pide una frase de paso
   ```
3. Descargue el certificado intermedio **Apple WWDR G4** desde <https://www.apple.com/certificateauthority/>
   (`AppleWWDRCAG4.cer`; se acepta tal cual, en DER o PEM).
4. Variables (cada archivo en base64, igual que arriba):
   ```
   APPLE_PASS_TYPE_IDENTIFIER=pass.cr.nanotap.loyalty
   APPLE_TEAM_IDENTIFIER=<Team ID de 10 caracteres>
   APPLE_WWDR_CERT_BASE64=...
   APPLE_SIGNER_CERT_BASE64=...
   APPLE_SIGNER_KEY_BASE64=...
   APPLE_SIGNER_KEY_PASSPHRASE=<la frase del paso 2>
   ```
5. El push a APNs usa el mismo certificado del Pass Type ID: no hace falta nada más. (Opcionalmente puede
   usar una llave `.p8` con `APPLE_APNS_KEY_BASE64` + `APPLE_APNS_KEY_ID`; el método documentado por Apple
   para Wallet es el certificado, así que pruebe primero sin la `.p8`.)

**`BASE_URL` debe ser HTTPS** con certificado válido: el iPhone no registra passes contra un web service http.
Si el pass no se actualiza, revise los logs con `"operacion":"apple.log"`: son los errores que reporta el propio iPhone.

**Vencimiento (RNF-10):** el certificado del Pass Type ID dura un año. El servidor lo revisa al arrancar y
cada 24 h y deja un `warn` en el log cuando faltan menos de 30 días (`error` si ya venció). El panel del
operador muestra los días restantes. Renovarlo = repetir los pasos 2 y 4.

---

## 4. Cómo funciona

```
Staff escanea QR ──► POST /api/clientes/:id/sello ──► sumar_sello() en Postgres (atómico)
                                                      │  incrementa, registra evento, marca pass modificado
                     respuesta al staff (< 2 s) ◄─────┘
                                                      │  después de responder:
                     walletSync.sincronizarCliente ───┼──► Google: loyaltyobject.patch
                                                      └──► Apple: push APNs → el iPhone pide el pass nuevo
                     si falla ──► wallet_sync_pendientes ──► worker reintenta cada 30 s con backoff (hasta 12 veces)
```

- **Aislamiento por negocio (RF-04):** el JWT del staff lleva su `negocio_id`; cada ruta lo compara con el del
  cliente (403 si no coincide) y las funciones SQL lo vuelven a verificar. Desactivar un usuario o un negocio
  tiene efecto inmediato (se verifica en cada request).
- **Seguridad de Supabase:** todas las tablas tienen RLS activado sin políticas, y las funciones no son
  ejecutables por `anon`. Solo el backend (service_role) puede leer o escribir.
- **Diseño de la tarjeta (minimalista):** arriba el logo y el nombre del negocio con el contador de estampas; al
  centro la zona de estampas; abajo el premio, cuántas faltan y el QR. Los datos del cliente van al reverso (Apple)
  o al detalle (Google).
- **Estampas:** cada estampa es el logo del negocio (o una imagen propia de estampa): **a color** si ya se obtuvo y
  **en gris tenue** si falta. Los logos con fondo sólido se recortan en círculo. Sin logo, se dibujan círculos con
  los colores del negocio. La imagen se genera en el servidor (`services/estampas.service.js`); Google la descarga
  de `/img/negocios/:id/estampas.png`.
- **Reglas del programa:** van en el reverso (Apple), en el detalle (Google) y en la página de inscripción. Hay
  reglas sugeridas (`src/utils/reglas.js`) que se ajustan solas al nombre, premio y cantidad de estampas; cada
  negocio puede tener las suyas desde el panel (una por línea).
- **Imágenes de marca:** el operador sube el logo y la imagen de la estampa desde `/operador/` (PNG, JPG, WebP o
  SVG, hasta 5 MB). Se convierten a PNG y se guardan en Supabase Storage, en el bucket público `marcas`, que se
  crea solo la primera vez. Al cambiar la marca, todas las tarjetas del negocio se actualizan en segundo plano.

### Estructura

```
src/
  app.js                       entrypoint Express (rutas, páginas, seguridad, errores)
  config/env.js                carga y valida variables; decodifica certificados en memoria
  db/schema.sql                esquema + funciones sumar_sello / canjear_premio
  db/supabaseClient.js
  middlewares/                 auth (JWT staff/operador) y límites por IP
  routes/                      negocios, clientes, staff, operador, wallet.apple, wallet.google, imagenes
  services/
    sellos.service.js          RF-05 / RF-06
    clientes.service.js        inscripción, búsqueda, eliminación (Ley 8968)
    googleWallet.service.js    clase/objeto/link firmado
    appleWallet.service.js     .pkpass + revisión de certificados
    apnsPush.service.js        push HTTP/2 a APNs
    walletSync.service.js      propagación a wallets + cola de reintentos
    imagen.service.js          PNG de sellos e íconos (sin dependencias)
    qrcode.service.js
  public/                      páginas (inscripción, consulta, privacidad, staff, operador)
scripts/seed-demo.js
test/                          npm test
```

### API

Las rutas de la sección 8 de la especificación, más:

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `POST` | `/api/operador/login` | Pública | `{ password }` → JWT de operador |
| `GET` | `/api/operador/negocios` | Operador | Negocios con total de clientes y staff (RF-08) |
| `GET` | `/api/operador/clientes?negocio_id=&q=` | Operador | Buscar clientes (teléfono, correo, nombre) |
| `GET` | `/api/operador/estado` | Operador | Wallets configurados, vencimiento de certificados, reintentos pendientes |
| `PATCH` | `/api/negocios/:id` | Operador | Editar / activar / desactivar; re-sincroniza las tarjetas si cambia la marca |
| `GET`/`POST` | `/api/negocios/:id/staff` | Operador | Listar / crear usuarios de staff |
| `PATCH` | `/api/staff/:id` | Operador | Activar/desactivar, nombre, nueva contraseña |
| `GET` | `/api/staff/yo` | Staff | Datos de la sesión |
| `DELETE` | `/api/clientes/:id` | Operador | Eliminación completa de datos (Ley 8968) |
| `GET` | `/api/negocios/:slug/clientes/export?tipo=eventos` | Staff/Operador | CSV del historial de sellos y canjes |

Login de staff: `POST /api/staff/login` con `{ negocio: "<slug>", usuario, password }`.
Las rutas del staff y del operador usan `Authorization: Bearer <token>`.

---

## 5. Supuestos y desviaciones de la especificación

Resueltos a favor de lo más simple que cumple el requerimiento:

1. **Columnas/tablas agregadas:** `clientes.acepto_terminos_en` (fecha del consentimiento, sección 12),
   `wallet_passes.auth_token` (el `authenticationToken` que exige Apple), tabla `wallet_sync_pendientes`
   (cola de reintentos, RNF-03) y vista `negocios_resumen` (RF-08).
2. **Sellos y canjes con funciones SQL** (`sumar_sello`, `canjear_premio`): Supabase JS no permite
   `sellos = sellos + 1` atómico, y así dos escaneos simultáneos no pierden sellos.
3. **Operador:** la spec no define su autenticación. Se usa una contraseña única (`OPERADOR_PASSWORD`).
   El panel `/operador/` cubre RF-01, RF-08, RF-09, la creación de staff y la eliminación de datos.
4. **Login de staff** pide el slug del negocio, porque el usuario es único por negocio (`unique (negocio_id, usuario)`).
5. **`GET /api/clientes/:id`** acepta el uuid o el código del QR (lo que lee el escáner).
6. **Teléfonos** se guardan normalizados (solo dígitos, sin `506`), para que `8888-7777` y `+506 88887777` sean el mismo cliente.
7. **Primer apellido** es obligatorio en el formulario (la spec lo lista sin "(opcional)").
8. **Inscripción repetida:** si el teléfono ya existe se muestra la tarjeta existente sin modificar sus datos.
   Esto implica que quien conozca el teléfono puede ver la tarjeta (nombre y QR); es lo que pide RF-02.
9. **Consulta de saldo (RF-10)** solo devuelve nombre de pila y sellos, para exponer lo mínimo.
10. **APNs** con HTTP/2 nativo en lugar de `node-apn` (sin mantenimiento); la spec permite "equivalente HTTP/2".
11. **`@googleapis/walletobjects`** en vez del paquete completo `googleapis`: es el mismo cliente oficial, solo la API de Wallet.
12. **El slug no se puede cambiar** después de crear el negocio (rompería enlaces y material impreso).
13. **Exportación extra** `?tipo=eventos` con el historial de sellos/canjes, útil para Power BI.
14. La spec dice "ver sección 10" para la Ley 8968; el contenido está en la sección 12.

---

## 6. Operación

- **Solicitud de eliminación (Ley 8968):** panel del operador → negocio → *Clientes* → buscar → *Eliminar*.
  Borra cliente, historial y registros de dispositivos, e inactiva la tarjeta de Google. La tarjeta de Apple
  queda en el iPhone del cliente pero deja de actualizarse (Apple no permite borrarla remotamente).
- **Aviso de privacidad:** `src/public/privacidad.html` es una **plantilla**; debe revisarla un abogado antes de
  producción. El correo de contacto sale de `CONTACTO_PRIVACIDAD`.
- **Logs (RNF-07):** una línea JSON por evento, con `negocio_id`, `cliente_id` y `operacion`. Cada llamada a
  Google/APNs queda registrada con su duración y, si falla, con el detalle del error.
- **Botones oficiales:** Apple y Google piden usar sus insignias oficiales ("Add to Apple Wallet",
  "Add to Google Wallet"). Los botones actuales son de texto; descargue las insignias de sus guías de marca y
  reemplácelas en `inscripcion.html` antes de salir a producción.

## 7. Pruebas

```bash
npm test
```

- `test/schema.test.js`: ejecuta `schema.sql` en un Postgres embebido (PGlite) y prueba sellos, canjes,
  aislamiento entre negocios y negocio inactivo.
- `test/unidad.test.js`: validaciones, CSV, PNG, objeto y link firmado de Google, `.pkpass` firmado (con
  certificados autofirmados) incluyendo los SHA-1 del manifest, y alerta de vencimiento.
- `test/app.test.js`: servidor HTTP sin BD: páginas, auth, validaciones, errores.

**Lo que no cubren las pruebas** (requiere credenciales reales): llamadas reales a Supabase, a la API de
Google Wallet y a APNs, y la instalación del pass en un iPhone. Ese es el siguiente paso de validación (DoD §13).

**Dependencias:** `npm audit` reporta avisos en `joi` y `node-forge`, que vienen de `passkit-generator`.
En este uso no son explotables (joi solo valida datos propios; de forge solo se usa la firma, no la
verificación), pero conviene actualizar `passkit-generator` cuando publique una versión corregida.
