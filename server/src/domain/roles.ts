/**
 * The roles of the accounts. The specialist (owner, 17/10/2026) works on his own for other companies,
 * with his own section (templates, connectors, installations) and the technical tools of the admins.
 * He may be someone outside CDA Net (issue #275): by default he sees only his own work and that of
 * his work groups, never CDA Net's customers, network or the work of others; the admins may give an
 * internal specialist «visibilità piena» (users.full_view). The management of the platform and the
 * decisions on CDA Net's work stay with the admins.
 */
export const ROLES = ['admin', 'installer', 'specialist'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Admins and specialists: the technical tools that show no data of others (maps, terrain, firmware,
 * template form, guide) and the same security policy (two-step verification, login notices).
 */
export const isStaff = (role: string | undefined | null): boolean => role === 'admin' || role === 'specialist';

/**
 * Who sees CDA Net's data of everyone (customers, network, work orders, installations and tests of
 * others): the admins, and the specialists an admin gave «visibilità piena». Never implicit.
 */
export const seesAll = (u: { role: string; fullView?: boolean | number | null } | null | undefined): boolean =>
  !!u && (u.role === 'admin' || (u.role === 'specialist' && !!u.fullView));

/** The role in the words of the console and of the notices. */
export const roleLabel = (role: string): string => (role === 'admin' ? 'amministratore' : role === 'specialist' ? 'specialist' : 'installatore');
