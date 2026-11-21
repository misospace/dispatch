import { projectCourierSurface } from "@/lib/external-contribution-view";
import { ContributionsClient } from "./contributions-client";

/**
 * Operator contribution interface (#1539, parent #1349). The page shell is a
 * server render so the configuration summary (endpoint, approved namespaces,
 * credential presence, named capability gaps) is resolved server-side by the
 * shared projection — credentials never enter the client tree. All request
 * data then flows through the maintainer-tier `/api/external-contributions`
 * routes, like every other operator surface.
 *
 * Access to this server render is covered by the global middleware
 * (`src/middleware.ts`): its matcher guards every non-public route, so
 * `/contributions` requires Basic credentials (`DISPATCH_AUTH_MODE=basic`) or
 * an OIDC session (`oidc`) before it renders — the same protection and the
 * same posture as `/board`, `/agents`, and `/projects`, which server-render
 * strictly more data than the config panel does. `disabled` is an explicit
 * operator opt-out and legacy (no mode set) ships no page auth for any route;
 * both are instance-wide posture choices, not gaps specific to this page.
 */
export default function ContributionsPage() {
  return <ContributionsClient config={projectCourierSurface()} />;
}
