/**
 * The roles of the console. The specialist (owner, 17/10/2026) has his own section and the technical
 * tools; he may be outside CDA Net (issue #275), so CDA Net's data of everyone (customers, network,
 * work of others) only with «visibilità piena», given by an admin. The management of the platform and the decisions on CDA
 * Net's work (approving tests, closing KOs, planning work orders, warehouse, CDA Net's templates and
 * Wi-Fi keys) stay with the admins: their buttons are shown to the admins only (the server refuses
 * them anyway).
 */
let current = '';

export const setRole = (role: string) => {
  current = role;
};

/** Admins and specialists: the technical tools that show no data of others. */
export const isStaff = (u?: { role: string } | null) => u?.role === 'admin' || u?.role === 'specialist';
/** The views of the NOC (CDA Net's data of everyone): admins, and specialists with «visibilità piena». */
export const seesAll = (u?: { role: string; fullView?: boolean } | null) => u?.role === 'admin' || (u?.role === 'specialist' && !!u.fullView);
export const isSpecialist = (u?: { role: string } | null) => u?.role === 'specialist';

/** Only the admins manage the platform and decide on CDA Net's work (the user logged in now). */
export const canManage = () => current === 'admin';

export const roleLabel = (role: string) => (role === 'admin' ? 'Admin' : role === 'specialist' ? 'Specialist' : 'Installatore');
/** The role in a sentence («amministratore», «specialist», «installatore»). */
export const roleWord = (role: string) => (role === 'admin' ? 'amministratore' : role === 'specialist' ? 'specialist' : 'installatore');
