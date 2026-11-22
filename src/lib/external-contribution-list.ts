/**
 * Bounds for the stored-requests listing (#1538), shared by the listing route
 * (`app/api/external-contributions/route.ts`) and the operator UI
 * (`app/contributions/contributions-client.tsx`). The UI asks for the widest
 * page the server answers with; a single source here means a server-side cap
 * change can never silently leave the browser requesting more than allowed.
 */
export const EXTERNAL_CONTRIBUTION_LIST_DEFAULT_LIMIT = 50;
export const EXTERNAL_CONTRIBUTION_LIST_MAX_LIMIT = 200;
