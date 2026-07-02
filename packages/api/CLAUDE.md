# @gladiator/api (Phasen 0b, 5, 6)

Express + tRPC-Router, echte Auth (JWT+Refresh, RBAC, Tenant-Scoping via ctx.user), WebSocket/SSE-Gateway, Pine-Webhook-Receiver (HMAC-signiert).
Regeln: protectedProcedure → 401 ohne gültiges Token (KEIN Demo-User-Fallback); userId NIE aus Client-Input; CORS-Whitelist, helmet, Rate-Limiting; Zod-Validierung aller Inputs. Spec: 10_ §3/§4, Abnahmen B0b/B5.
