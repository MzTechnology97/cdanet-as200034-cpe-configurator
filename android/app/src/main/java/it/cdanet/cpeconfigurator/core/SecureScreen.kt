package it.cdanet.cpeconfigurator.core

/** Who may take screenshots in the app (pure, tested). */
object SecureScreen {
    /**
     * Admins always may; any other account only when the server says its «Screenshot nell'app» is
     * on. Not known yet ([modules] null, no role) means blocked.
     */
    fun blocked(role: String?, modules: Map<String, Boolean>?): Boolean = when (role) {
        // admins and specialists always may
        "admin", "specialist" -> false
        null -> true
        else -> modules?.get("screenshots") != true
    }
}
