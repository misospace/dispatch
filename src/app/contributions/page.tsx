import { projectCourierSurface } from "@/lib/external-contribution-view";
import { ContributionsClient } from "./contributions-client";

/**
 * Operator contribution interface (#1539, parent #1349). The page shell is a
 * server render so the configuration summary (endpoint, approved namespaces,
 * credential presence, named capability gaps) is resolved server-side by the
 * shared projection — credentials never enter the client tree. All request
 * data then flows through the maintainer-tier `/api/external-contributions`
 * routes, like every other operator surface.
 */
export default function ContributionsPage() {
  return <ContributionsClient config={projectCourierSurface()} />;
}
