/**
 * The roles of the accounts. The specialist (owner, 17/10/2026) works on his own for other companies:
 * he sees everything like an administrator and uses every tool of the admins and of the installers,
 * with his own section (templates, connectors, installations); the management of the platform and
 * the decisions on CDA Net's work stay with the admins.
 */
export const ROLES = ['admin', 'installer', 'specialist'] as const;
export type Role = (typeof ROLES)[number];

/** Who sees everything like an administrator: the admins and the specialists. */
export const isStaff = (role: string | undefined | null): boolean => role === 'admin' || role === 'specialist';

/** The role in the words of the console and of the notices. */
export const roleLabel = (role: string): string => (role === 'admin' ? 'amministratore' : role === 'specialist' ? 'specialist' : 'installatore');
