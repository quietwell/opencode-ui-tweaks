/**
 * opencode-ui-tweaks, server part. The plugin does all its work in the Desktop window (see gui.tsx); this entry only
 * gives it the id the app loads the `./gui-experimental` bundle under.
 */
export const PLUGIN_ID = "sidebar-sections"

export default { id: PLUGIN_ID, setup: async () => {} }
