/**
 * The roles of the accounts. The specialist (owner, 17/10/2026) works on his own for other
 * companies, with his own section (templates, connectors, installations), and may be a person
 * outside CDA Net (#275): he sees his own data and those of his work groups, never the work of the
 * others (customers, installers, CDA Net's network), unless an admin gives him the full view
 * (off by default). The management of the platform and the decisions on CDA Net's work stay
 * with the admins.
 */
export const ROLES = ['admin', 'installer', 'specialist'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Admins and specialists: the accounts held to the admins' security (two-step verification when it
 * is required, security notices, login notices). It does not say what they see: see [seesAll].
 */
export const isStaff = (role: string | undefined | null): boolean => role === 'admin' || role === 'specialist';

/**
 * Who sees the work and the data of the others (customers, installers, CDA Net's network and
 * jobs): the admins, and a specialist only with the full view an admin gave him. Everyone else
 * sees his own, like an installer.
 */
export const seesAll = (u: { role: string; fullView?: boolean | undefined } | null | undefined): boolean =>
  !!u && (u.role === 'admin' || (u.role === 'specialist' && u.fullView === true));

/** The role in the words of the console and of the notices. */
export const roleLabel = (role: string): string => (role === 'admin' ? 'amministratore' : role === 'specialist' ? 'specialist' : 'installatore');
