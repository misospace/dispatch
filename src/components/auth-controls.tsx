import { getAuthMode } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { LogoutButton } from "./logout-button";

/**
 * Server component that conditionally renders logout controls.
 *
 * Shows the logout button when:
 * - OIDC mode is active AND a session exists, OR
 * - Basic Auth mode is active (credentials are managed client-side)
 */
export async function AuthControls() {
  const authMode = getAuthMode();

  if (!authMode || authMode === "disabled") {
    return null;
  }

  // In OIDC mode, only show logout if there's an active session
  if (authMode === "oidc") {
    const session = await getSession();
    if (!session?.user) {
      return null;
    }
  }

  return <LogoutButton />;
}
