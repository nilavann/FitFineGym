-- Assertion helpers and fixtures for the fitfine backend tests. Every test file includes this right after its BEGIN and ends in ROLLBACK, so the
-- schema t, the fixtures and every row a test writes vanish with the transaction. Nothing is left
-- on the database the tests ran against (rolled-back inserts still consume identity values).
--
-- Results are NOTICE lines: "ok - <name>" or "not ok - <name> (<detail>)". run.sh fails on any
-- "not ok". Assertions run as the session user (postgres); t.try runs one statement as another
-- role and reports what happened, so the checks themselves never depend on the role under test.

create schema t;

create function t.ok(p_name text, p_cond boolean, p_detail text default null) returns void
language plpgsql as $$
begin
  if coalesce(p_cond, false) then raise notice 'ok - %', p_name;
  else raise notice 'not ok - %', p_name || coalesce(' (' || p_detail || ')', ''); end if;
end $$;

create function t.eq(p_name text, p_actual anyelement, p_expected anyelement) returns void
language plpgsql as $$
begin
  if p_actual is not distinct from p_expected then raise notice 'ok - %', p_name;
  else raise notice 'not ok - % (expected %, got %)', p_name, p_expected, p_actual; end if;
end $$;

-- Runs p_sql as p_role (anon, authenticated or service_role) with auth.uid() = p_uid, inside a
-- subtransaction that is always rolled back, and reports the outcome:
--   'rows:<n>'      the statement ran and touched / returned n rows
--   'err:<sqlstate>:<message>'
-- The role, the claims and every row written are undone when the block exits.
create function t.try(p_role text, p_uid uuid, p_sql text) returns text
language plpgsql as $$
declare
  v_rows bigint;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    perform set_config('request.jwt.claims',
      case when p_uid is null then '' else jsonb_build_object('sub', p_uid, 'role', p_role)::text end, true);
    execute format('set local role %I', p_role);
    execute p_sql;
    get diagnostics v_rows = row_count;
    raise exception using errcode = 'TT000', message = v_rows::text;
  exception
    when sqlstate 'TT000' then return 'rows:' || sqlerrm;
    when others then return 'err:' || sqlstate || ':' || sqlerrm;
  end;
end $$;

-- Passes when p_sql, run as p_role / p_uid, raises with SQLSTATE p_state (and, when given, a
-- message matching p_message, ILIKE).
create function t.raises(p_name text, p_role text, p_uid uuid, p_sql text, p_state text, p_message text default '%')
returns void language plpgsql as $$
declare
  v text := t.try(p_role, p_uid, p_sql);
begin
  perform t.ok(p_name, v like 'err:' || p_state || ':%' and substr(v, 11) ilike p_message, v);
end $$;

-- Passes when p_sql, run as p_role / p_uid, completes without an error.
create function t.runs(p_name text, p_role text, p_uid uuid, p_sql text) returns void
language plpgsql as $$
declare
  v text := t.try(p_role, p_uid, p_sql);
begin
  perform t.ok(p_name, v like 'rows:%', v);
end $$;

-- Signs in as a fixture user (authenticated) for the statements that follow, until t.logout().
-- Unlike t.try, what they write stays (until the file's ROLLBACK).
create function t.login(p_who text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', t.uid(p_who)::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.uid(p_who), 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

create function t.logout() returns void
language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Runs p_sql for real (not rolled back) as service_role, the way an Edge Function calls an RPC.
-- The claims an RPC's act_as set are cleared again afterwards.
create function t.as_service(p_sql text) returns void
language plpgsql as $$
begin
  set local role service_role;
  execute p_sql;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Fixtures ------------------------------------------------------------------------------------
-- Fixed ids, chosen so they can't collide with real rows on a scratch project.

create function t.uid(p_name text) returns uuid language sql immutable as $$
  select ('f17f1e00-0000-4000-8000-' || lpad(
    case p_name
      when 'nop'      then '1' when 'inactive' then '2' when 'norole' then '3'
      when 'staff'    then '4' when 'admin'    then '5' when 'sysadmin' then '6'
      when 'deleted'  then '7' when 'staff2'   then '8' when 'admin2' then '9'
    end, 12, '0'))::uuid
$$;

create function t.role_id(p_name text) returns smallint language sql stable as $$
  select id from fitfine.roles where name = p_name and deleted_at is null
$$;

create function t.branch(p_code text) returns bigint language sql stable as $$
  select id from fitfine.branches where code = p_code and deleted_at is null
$$;

create function t.plan(p_name text) returns bigint language sql stable as $$
  select id from fitfine.plans where name = p_name and deleted_at is null
$$;

-- An invited auth user, the way GoTrue's invite creates one: invited_at set, the invite metadata in
-- raw_user_meta_data. handle_new_auth_user (the real trigger) creates the profile and roles.
create function t.invite(p_name text, p_roles text[], p_invited_by uuid default null) returns uuid
language plpgsql as $$
begin
  insert into auth.users (id, email, invited_at, raw_user_meta_data)
  values (t.uid(p_name), p_name || '@fitfine.test', now(), jsonb_build_object(
    'full_name', initcap(p_name) || ' Test',
    'invited_by', p_invited_by,
    'role_ids', (select coalesce(jsonb_agg(t.role_id(r)), '[]') from unnest(p_roles) r)));
  return t.uid(p_name);
end $$;

-- A member inserted directly (as the owner); returns its id.
create function t.member(p_phone text, p_branch text default 'TA', p_name text default 'Test Member')
returns bigint language sql as $$
  insert into fitfine.members (name, phone, date_of_birth, gender, weight_kg, height_cm,
    emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, branch_id)
  values (p_name, p_phone, '1990-01-01', 'Male', 70, 170, 'Contact', '9999999999', 'Friend', t.branch(p_branch))
  returning id
$$;

-- The fixture world: three roles, every kind of user, two branches, three plans, two members with
-- a subscription each. Works on an empty database and on one that already holds real data.
create function t.seed() returns void
language plpgsql as $$
declare
  v_m1 bigint;
  v_s1 bigint;
begin
  insert into fitfine.roles (name, description)
  select r, 'test fixture' from unnest(array['admin', 'staff', 'system_admin']) r
  where not exists (select 1 from fitfine.roles x where x.name = r and x.deleted_at is null);

  insert into fitfine.configuration (key, value) values
    ('member_number_start_sequence', '1'), ('member_number_increment', '1'), ('member_number_padding_width', '4')
  on conflict (key) do nothing;

  -- nop: an uninvited sign-up, so no profile at all.
  insert into auth.users (id, email) values (t.uid('nop'), 'nop@fitfine.test');
  perform t.invite('sysadmin', array['admin', 'system_admin']);
  perform t.invite('admin',    array['admin'],  t.uid('sysadmin'));
  perform t.invite('admin2',   array['admin'],  t.uid('sysadmin'));
  perform t.invite('staff',    array['staff'],  t.uid('admin'));
  perform t.invite('staff2',   array['staff'],  t.uid('admin'));
  perform t.invite('inactive', array['staff'],  t.uid('admin'));
  perform t.invite('deleted',  array['staff'],  t.uid('admin'));
  perform t.invite('norole',   array[]::text[], t.uid('admin'));
  update fitfine.profiles set is_active = false where id = t.uid('inactive');
  update fitfine.profiles set deleted_at = now() where id = t.uid('deleted');

  -- TAB starts with TA: set_member_number_sequence must keep the two apart.
  insert into fitfine.branches (name, code) values ('Test Branch A', 'TA'), ('Test Branch AB', 'TAB');
  insert into fitfine.plans (name, category, duration_days, price, max_members) values
    ('T Monthly', 'membership', 30, 1000, 1),
    ('T Couple',  'membership', 30, 1800, 2),
    ('T Locker',  'addon',      null, 200, 1);

  v_m1 := t.member('5550000001', 'TA', 'Member One');
  perform t.member('5550000002', 'TA', 'Member Two');
  insert into fitfine.subscriptions (member_id, payment_mode) values (v_m1, 'Cash') returning id into v_s1;
  insert into fitfine.subscription_items (subscription_id, plan_id, member_id, start_date, end_date, quantity, amount_paid)
  values (v_s1, t.plan('T Monthly'), v_m1, current_date, current_date + 29, 1, 1000);
end $$;

grant usage on schema t to public;
grant execute on all functions in schema t to public;
