import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { ManageUsersPage } from './ManageUsersPage';
import { userService as realUserService } from '../services/user.service';
import { fakeServices } from '../test/fakes';
import { renderWithProviders, type RenderOptions } from '../test/render';
import { buildAdminProfile, buildRole } from '../test/builders';
import { MOBILE_WIDTH } from '../test/viewport';
import type { ManagedUser } from '../types/profile';

const user = (overrides: Partial<ManagedUser>): ManagedUser => ({
  id: 'u',
  full_name: 'Someone',
  roles: ['staff'],
  is_active: true,
  email: 'someone@fitandfine.in',
  ...overrides,
});

const ME = user({ id: 'me', full_name: 'Anita Admin', roles: ['admin'], email: 'anita@fitandfine.in' });
const RAVI = user({ id: 'u-ravi', full_name: 'Ravi Kumar', roles: ['staff'], email: 'ravi@fitandfine.in' });
const OFF = user({ id: 'u-off', full_name: 'Omar Sheikh', is_active: false, email: 'omar@fitandfine.in' });
const USERS = [ME, RAVI, OFF];

function renderUsers(
  options: RenderOptions & {
    users?: ManagedUser[];
    getAll?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    roleNames?: string[];
  } = {}
) {
  const {
    users = USERS,
    getAll = vi.fn().mockResolvedValue(users),
    update = vi.fn().mockResolvedValue(RAVI),
    roleNames = ['admin', 'staff'],
    ...rest
  } = options;
  const getAllActive = vi.fn().mockResolvedValue(roleNames.map((name, i) => buildRole({ id: i + 1, name })));
  const utils = renderWithProviders(<ManageUsersPage />, {
    auth: { currentProfile: buildAdminProfile({ id: 'me', full_name: 'Anita Admin' }) },
    ...rest,
    services: fakeServices({
      roleRepository: { getAllActive },
      userService: { ...realUserService, getAll, update },
    }),
  });
  return { ...utils, getAll, update };
}

const ready = () => screen.findByRole('heading', { name: 'Manage Users' });
const rowFor = (name: string) => screen.getByText(name).closest('tr, .users-card') as HTMLElement;
const dialog = () => document.querySelector('.users-delete-dialog') as HTMLElement;

describe('ManageUsersPage — data states', () => {
  it('shows a skeleton while loading', () => {
    renderUsers({ getAll: vi.fn().mockReturnValue(new Promise(() => undefined)) });
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('a network failure offers Retry and recovers', async () => {
    const getAll = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(USERS);
    const { user: u } = renderUsers({ getAll });
    expect(await screen.findByText("Couldn't load users — check your connection and try again.")).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await ready()).toBeInTheDocument();
  });

  it('a generic failure never shows the raw error', async () => {
    renderUsers({ getAll: vi.fn().mockRejectedValue(new Error('PGRST raw')) });
    expect(await screen.findByText('Something went wrong loading users. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/PGRST/)).not.toBeInTheDocument();
  });

  it('shows the success toast InviteUserPage hands over, and it can be dismissed', async () => {
    const { user: u } = renderUsers({ routeState: { toast: 'Invitation sent to ravi@fitandfine.in' } });
    await ready();
    expect(screen.getByText('Invitation sent to ravi@fitandfine.in')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Invitation sent to ravi@fitandfine.in')).not.toBeInTheDocument();
  });
});

describe('ManageUsersPage renders exactly ONE of table / cards', () => {
  it('on desktop: a table, one row per user, no cards', async () => {
    renderUsers({ viewport: 1280 });
    await ready();
    expect(document.querySelectorAll('table')).toHaveLength(1);
    expect(within(document.querySelector('table') as HTMLElement).getAllByRole('row')).toHaveLength(USERS.length + 1);
    expect(document.querySelector('.users-cards')).toBeNull();
  });

  it('on a phone: cards, one per user, no table', async () => {
    renderUsers({ viewport: MOBILE_WIDTH });
    await ready();
    expect(document.querySelectorAll('table')).toHaveLength(0);
    expect(document.querySelectorAll('.users-card')).toHaveLength(USERS.length);
  });
});

describe.each([
  ['desktop table', 1280],
  ['phone cards', MOBILE_WIDTH],
])('ManageUsersPage rows — %s', (_label, viewport) => {
  it('shows email, role badge and status, and tags the signed-in admin "(you)"', async () => {
    renderUsers({ viewport });
    await ready();

    expect(within(rowFor('Anita Admin')).getByText('(you)')).toBeInTheDocument();
    expect(within(rowFor('Anita Admin')).getByText('anita@fitandfine.in')).toBeInTheDocument();
    expect(within(rowFor('Anita Admin')).getByText('admin')).toHaveClass('users-role-admin');
    expect(within(rowFor('Ravi Kumar')).getByText('Active')).toBeInTheDocument();
    expect(within(rowFor('Omar Sheikh')).getByText('Deactivated')).toBeInTheDocument();
    expect(within(rowFor('Ravi Kumar')).queryByText('(you)')).not.toBeInTheDocument();
  });

  it('will not let you deactivate yourself (the server rejects it too)', async () => {
    renderUsers({ viewport });
    await ready();
    expect(screen.getByRole('button', { name: 'Deactivate Anita Admin' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deactivate Ravi Kumar' })).toBeEnabled();
  });
});

describe('ManageUsersPage — editing', () => {
  it('changes another user’s name and roles, sending both', async () => {
    const { user: u, update } = renderUsers({ viewport: 1280 });
    await ready();
    await u.click(screen.getByRole('button', { name: 'Edit Ravi Kumar' }));

    await u.clear(screen.getByLabelText(/^Name/));
    await u.type(screen.getByLabelText(/^Name/), 'Ravi K');
    await u.click(within(screen.getByRole('group', { name: 'Roles' })).getByRole('button', { name: 'admin' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));

    expect(update).toHaveBeenCalledWith('u-ravi', { full_name: 'Ravi K', roles: ['staff', 'admin'] });
  });

  it('editing YOURSELF locks the role chips and sends only the name (update-user rejects the rest)', async () => {
    const { user: u, update } = renderUsers({ viewport: 1280 });
    await ready();
    await u.click(screen.getByRole('button', { name: 'Edit Anita Admin' }));

    for (const chip of within(screen.getByRole('group', { name: 'Roles' })).getAllByRole('button')) expect(chip).toBeDisabled();
    expect(screen.getByText("You can't change your own roles.")).toBeInTheDocument();

    await u.clear(screen.getByLabelText(/^Name/));
    await u.type(screen.getByLabelText(/^Name/), 'Anita A');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith('me', { full_name: 'Anita A' });
  });

  it('requires a name and at least one role', async () => {
    const { user: u, update } = renderUsers({ viewport: 1280 });
    await ready();
    await u.click(screen.getByRole('button', { name: 'Edit Ravi Kumar' }));
    await u.clear(screen.getByLabelText(/^Name/));
    await u.click(within(screen.getByRole('group', { name: 'Roles' })).getByRole('button', { name: 'staff' })); // untick the only role
    await u.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Select at least one role')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('says why Save does nothing when the only role was unticked (a valid name must not hide it)', async () => {
    const { user: u, update } = renderUsers({ viewport: 1280 });
    await ready();
    await u.click(screen.getByRole('button', { name: 'Edit Ravi Kumar' }));
    await u.click(within(screen.getByRole('group', { name: 'Roles' })).getByRole('button', { name: 'staff' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Select at least one role')).toBeInTheDocument();
    expect(screen.queryByText('Name is required')).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['offline', new Error('Failed to fetch'), "Couldn't save — check your connection and try again."],
    ['any other failure', new Error('boom'), "Couldn't update this user. Please try again."],
  ])('shows a specific message when saving fails (%s) and keeps the form', async (_label, error, message) => {
    const { user: u } = renderUsers({ update: vi.fn().mockRejectedValue(error), viewport: 1280 });
    await ready();
    await u.click(screen.getByRole('button', { name: 'Edit Ravi Kumar' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edit User' })).toBeInTheDocument();
  });
});

describe('ManageUsersPage — deactivate and reactivate (users are never deleted)', () => {
  it('deactivating asks first, then flips is_active and reloads', async () => {
    const { user: u, update, getAll } = renderUsers({ viewport: 1280 });
    await ready();
    await u.click(screen.getByRole('button', { name: 'Deactivate Ravi Kumar' }));

    expect(screen.getByRole('heading', { name: 'Deactivate user?' })).toBeInTheDocument();
    expect(screen.getByText('Ravi Kumar will not be able to sign in.')).toBeInTheDocument();
    await u.click(within(dialog()).getByRole('button', { name: 'Deactivate' }));

    expect(update).toHaveBeenCalledWith('u-ravi', { is_active: false });
    await vi.waitFor(() => expect(getAll).toHaveBeenCalledTimes(2));
  });

  it('reactivating a deactivated user flips it back', async () => {
    const { user: u, update } = renderUsers({ viewport: 1280 });
    await ready();
    await u.click(screen.getByRole('button', { name: 'Reactivate Omar Sheikh' }));
    expect(screen.getByRole('heading', { name: 'Reactivate user?' })).toBeInTheDocument();
    await u.click(within(dialog()).getByRole('button', { name: 'Reactivate' }));
    expect(update).toHaveBeenCalledWith('u-off', { is_active: true });
  });

  it('offers no delete, restore or "show deleted" control: a user is only deactivated', async () => {
    renderUsers({ viewport: 1280 });
    await ready();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Restore / })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /deleted/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });

  it('asks the service for every user once, with no include-deleted option', async () => {
    const { getAll } = renderUsers({ viewport: 1280 });
    await ready();
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll).toHaveBeenCalledWith();
  });
});

describe('ManageUsersPage — invite entry point', () => {
  it('links to the invite screen', async () => {
    renderUsers();
    await ready();
    expect(screen.getByRole('link', { name: /Invite User/ })).toHaveAttribute('href', '/users/invite');
  });
});
