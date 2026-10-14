/**
 * Wording by role: admins see where data comes from (UISP, modules…), installers get neutral text
 * (they do not need to know the systems behind the console).
 */
let admin = false;

export const setAdmin = (v: boolean) => {
  admin = !!v;
};
export const isAdminUser = () => admin;

/** [adminText] for admins, [installerText] for installers. */
export const nms = (adminText: string, installerText: string) => (admin ? adminText : installerText);
