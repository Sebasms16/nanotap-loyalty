// Configuración de Railway como código (reemplaza a railway.json, que Railway dejó de leer el 2026-12-01).
// Revisar con `railway config plan` y aplicar con `railway config apply`.
//
// OJO: este archivo describe TODO el servicio. Una variable que no esté en `env`
// se BORRA de Railway al aplicar. Las variables viven en Railway: aquí van como
// preserve() (Railway conserva su valor y nunca se escribe en el código). Si agrega
// una variable con `railway variable set`, agréguela también aquí como preserve().
// La regla de reinicio es la de Railway por defecto: si falla, reinicia (hasta 10 veces).
import { defineRailway, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const nanotapLoyalty = service("nanotap-loyalty", {
    start: "npm start",
    healthcheck: "/salud",
    healthcheckTimeout: 60,
    replicas: { "iad": 1 },
    domains: ["tarjetas.nanotap.app"],
    env: {
      APPLE_PASS_TYPE_IDENTIFIER: preserve(),
      APPLE_SIGNER_CERT_BASE64: preserve(),
      APPLE_SIGNER_KEY_BASE64: preserve(),
      APPLE_SIGNER_KEY_PASSPHRASE: preserve(),
      APPLE_TEAM_IDENTIFIER: preserve(),
      APPLE_WWDR_CERT_BASE64: preserve(),
      BASE_URL: preserve(),
      CONTACTO_PRIVACIDAD: preserve(),
      GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: preserve(),
      GOOGLE_WALLET_ISSUER_ID: preserve(),
      JWT_SECRET: preserve(),
      NODE_ENV: preserve(),
      OPERADOR_PASSWORD: preserve(),
      PORT: preserve(),
      SUPABASE_SERVICE_ROLE_KEY: preserve(),
      SUPABASE_URL: preserve(),
    },
  });

  return project("nanotap-loyalty", {
    resources: [nanotapLoyalty],
  });
});
