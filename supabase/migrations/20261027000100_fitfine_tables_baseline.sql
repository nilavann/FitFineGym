-- Baseline: the fitfine schema (tables, indexes, foreign keys and the base functions). Generated,
-- not hand-written:
--   pg_dump --schema-only --schema=fitfine --no-owner --no-privileges "$DB_URL"
-- with the dump's session settings and \restrict lines removed. Then one addition the dump can't
-- carry: trg_handle_new_auth_user lives on auth.users, outside the dumped schema.
--
-- The later migrations build on it; the trigger-functions migration replaces the six trigger
-- functions below with fitfine_private copies.

--
-- Name: fitfine; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA fitfine;

--
-- Name: audit_row_changes(); Type: FUNCTION; Schema: fitfine; Owner: -
--

CREATE FUNCTION fitfine.audit_row_changes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'fitfine'
    AS $$
declare
  v_change_id uuid := gen_random_uuid();
  v_old       jsonb;
  v_new       jsonb;
  v_record_id text;
  v_key       text;
  v_excluded  text[] := array['created_at', 'created_by', 'changed_at', 'changed_by'];
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_record_id := coalesce(v_new ->> 'id', (v_new ->> 'user_id') || ':' || (v_new ->> 'role_id'));
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key <> all(v_excluded) then
        insert into audit_log (change_id, table_name, record_id, field_name, old_value, new_value, operation, changed_by, changed_at)
        values (v_change_id, tg_table_name, v_record_id, v_key, null, v_new ->> v_key, 'insert', auth.uid(), now());
      end if;
    end loop;
    return new;

  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_record_id := coalesce(v_new ->> 'id', (v_new ->> 'user_id') || ':' || (v_new ->> 'role_id'));
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key <> all(v_excluded) and (v_old ->> v_key) is distinct from (v_new ->> v_key) then
        insert into audit_log (change_id, table_name, record_id, field_name, old_value, new_value, operation, changed_by, changed_at)
        values (v_change_id, tg_table_name, v_record_id, v_key, v_old ->> v_key, v_new ->> v_key, 'update', auth.uid(), now());
      end if;
    end loop;
    return new;

  elsif tg_op = 'DELETE' then
    -- Reachable only for user_roles (the one table exempt from prevent_hard_delete).
    v_old := to_jsonb(old);
    v_record_id := coalesce(v_old ->> 'id', (v_old ->> 'user_id') || ':' || (v_old ->> 'role_id'));
    for v_key in select jsonb_object_keys(v_old) loop
      if v_key <> all(v_excluded) then
        insert into audit_log (change_id, table_name, record_id, field_name, old_value, new_value, operation, changed_by, changed_at)
        values (v_change_id, tg_table_name, v_record_id, v_key, v_old ->> v_key, null, 'delete', auth.uid(), now());
      end if;
    end loop;
    return old;
  end if;

  return null;
end;
$$;

--
-- Name: generate_member_number(); Type: FUNCTION; Schema: fitfine; Owner: -
--

CREATE FUNCTION fitfine.generate_member_number() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'fitfine'
    AS $$
declare
  v_branch_code text;
  v_year        integer := extract(year from now())::integer;
  v_start       integer;
  v_increment   integer;
  v_width       integer;
  v_sequence    integer;
begin
  if tg_op = 'UPDATE' then
    new.member_number := old.member_number;
    new.branch_id      := old.branch_id;
    return new;
  end if;

  select code into v_branch_code from branches where id = new.branch_id and deleted_at is null;
  if v_branch_code is null then
    raise exception 'branch_id % does not reference an active branch', new.branch_id;
  end if;

  select value::integer into v_start     from configuration where key = 'member_number_start_sequence';
  select value::integer into v_increment from configuration where key = 'member_number_increment';
  select value::integer into v_width     from configuration where key = 'member_number_padding_width';

  insert into member_number_sequences (branch_id, last_sequence)
  values (new.branch_id, v_start)
  on conflict (branch_id)
  do update set last_sequence = member_number_sequences.last_sequence + v_increment
  returning last_sequence into v_sequence;

  new.member_number := v_branch_code || '-' || v_year || '-' || lpad(v_sequence::text, v_width, '0');
  return new;
end;
$$;

--
-- Name: handle_new_auth_user(); Type: FUNCTION; Schema: fitfine; Owner: -
--

CREATE FUNCTION fitfine.handle_new_auth_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'fitfine'
    AS $$
declare
  v_invited_by uuid := nullif(new.raw_user_meta_data ->> 'invited_by', '')::uuid;
begin
  if v_invited_by is not null then
    perform set_config('request.jwt.claim.sub', v_invited_by::text, true);
  end if;

  insert into profiles (id, full_name, is_active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

--
-- Name: prevent_hard_delete(); Type: FUNCTION; Schema: fitfine; Owner: -
--

CREATE FUNCTION fitfine.prevent_hard_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(current_setting('app.purge_member', true), '') = 'on'
     and tg_table_name in ('members', 'subscriptions', 'subscription_items', 'audit_log') then
    return old;
  end if;
  raise exception 'Hard delete is not allowed on table %. Soft-delete by setting deleted_at instead.', tg_table_name;
end;
$$;

--
-- Name: protect_system_admin_role(); Type: FUNCTION; Schema: fitfine; Owner: -
--

CREATE FUNCTION fitfine.protect_system_admin_role() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.name = 'system_admin' then
    raise exception 'The system_admin role is reserved and cannot be edited or deleted';
  end if;
  return new;
end;
$$;

--
-- Name: set_audit_fields(); Type: FUNCTION; Schema: fitfine; Owner: -
--

CREATE FUNCTION fitfine.set_audit_fields() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'fitfine'
    AS $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    new.changed_at := null;
    new.changed_by := null;
  elsif tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.changed_at := now();
    new.changed_by := auth.uid();
  end if;
  return new;
end;
$$;

--
-- Name: audit_log; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.audit_log (
    id bigint NOT NULL,
    change_id uuid NOT NULL,
    table_name text NOT NULL,
    record_id text NOT NULL,
    field_name text NOT NULL,
    old_value text,
    new_value text,
    operation text NOT NULL,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_log_operation_check CHECK ((operation = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])))
);

--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME fitfine.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: branches; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.branches (
    id bigint NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    changed_at timestamp with time zone,
    changed_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT chk_branches_code_not_blank CHECK ((TRIM(BOTH FROM code) <> ''::text)),
    CONSTRAINT chk_branches_name_not_blank CHECK ((TRIM(BOTH FROM name) <> ''::text))
);

--
-- Name: branches_id_seq; Type: SEQUENCE; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.branches ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME fitfine.branches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: configuration; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.configuration (
    key text NOT NULL,
    value text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    changed_at timestamp with time zone,
    changed_by uuid
);

--
-- Name: member_number_sequences; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.member_number_sequences (
    branch_id bigint NOT NULL,
    last_sequence integer NOT NULL
);

--
-- Name: members; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.members (
    id bigint NOT NULL,
    name text NOT NULL,
    phone text NOT NULL,
    date_of_birth date NOT NULL,
    date_of_joining date DEFAULT CURRENT_DATE NOT NULL,
    gender text NOT NULL,
    weight_kg numeric NOT NULL,
    height_cm numeric NOT NULL,
    under_doctor_care boolean DEFAULT false NOT NULL,
    doctor_care_details text,
    emergency_contact_name text NOT NULL,
    emergency_contact_phone text NOT NULL,
    emergency_contact_relationship text NOT NULL,
    email text,
    residential_address text,
    aadhaar_number text,
    occupation text,
    photo_url text,
    photo_thumbnail_url text,
    branch_id bigint NOT NULL,
    member_number text NOT NULL,
    handled_by_staff uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    changed_at timestamp with time zone,
    changed_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    pincode text,
    CONSTRAINT chk_doctor_care_details_required CHECK (((under_doctor_care = false) OR ((doctor_care_details IS NOT NULL) AND (length(TRIM(BOTH FROM doctor_care_details)) > 0)))),
    CONSTRAINT members_gender_check CHECK ((gender = ANY (ARRAY['Male'::text, 'Female'::text, 'Other'::text]))),
    CONSTRAINT members_height_cm_check CHECK (((height_cm >= (1)::numeric) AND (height_cm <= (300)::numeric))),
    CONSTRAINT members_weight_kg_check CHECK (((weight_kg >= (1)::numeric) AND (weight_kg <= (500)::numeric)))
);

--
-- Name: members_id_seq; Type: SEQUENCE; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.members ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME fitfine.members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: plans; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.plans (
    id bigint NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    duration_days integer,
    price numeric(10,2) NOT NULL,
    max_members integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    changed_at timestamp with time zone,
    changed_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT chk_plan_duration_required_when_membership CHECK (((category <> 'membership'::text) OR (duration_days IS NOT NULL))),
    CONSTRAINT chk_plan_max_members_only_for_membership CHECK (((category = 'membership'::text) OR (max_members = 1))),
    CONSTRAINT chk_plans_name_not_blank CHECK ((TRIM(BOTH FROM name) <> ''::text)),
    CONSTRAINT plans_category_check CHECK ((category = ANY (ARRAY['membership'::text, 'addon'::text]))),
    CONSTRAINT plans_duration_days_check CHECK ((duration_days > 0)),
    CONSTRAINT plans_max_members_check CHECK (((max_members >= 1) AND (max_members <= 2))),
    CONSTRAINT plans_price_check CHECK ((price >= (0)::numeric))
);

--
-- Name: plans_id_seq; Type: SEQUENCE; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.plans ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME fitfine.plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: profiles; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.profiles (
    id uuid NOT NULL,
    full_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    changed_at timestamp with time zone,
    changed_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid
);

--
-- Name: roles; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.roles (
    id smallint NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    changed_at timestamp with time zone,
    changed_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT chk_roles_name_not_blank CHECK ((TRIM(BOTH FROM name) <> ''::text))
);

--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.roles ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME fitfine.roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: subscription_items; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.subscription_items (
    id bigint NOT NULL,
    subscription_id bigint NOT NULL,
    plan_id bigint NOT NULL,
    member_id bigint NOT NULL,
    shared_member_id bigint,
    start_date date DEFAULT CURRENT_DATE NOT NULL,
    end_date date,
    quantity integer DEFAULT 1 NOT NULL,
    amount_paid numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    changed_at timestamp with time zone,
    changed_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT chk_subscription_item_shared_member_distinct CHECK (((shared_member_id IS NULL) OR (shared_member_id <> member_id))),
    CONSTRAINT subscription_items_amount_paid_check CHECK ((amount_paid >= (0)::numeric)),
    CONSTRAINT subscription_items_quantity_check CHECK ((quantity > 0))
);

--
-- Name: subscription_items_id_seq; Type: SEQUENCE; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.subscription_items ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME fitfine.subscription_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: subscriptions; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.subscriptions (
    id bigint NOT NULL,
    member_id bigint NOT NULL,
    payment_mode text DEFAULT 'Cash'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    changed_at timestamp with time zone,
    changed_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT subscriptions_payment_mode_check CHECK ((payment_mode = ANY (ARRAY['Cash'::text, 'UPI'::text, 'Card'::text])))
);

--
-- Name: subscriptions_id_seq; Type: SEQUENCE; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.subscriptions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME fitfine.subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: user_roles; Type: TABLE; Schema: fitfine; Owner: -
--

CREATE TABLE fitfine.user_roles (
    user_id uuid NOT NULL,
    role_id smallint NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    granted_by uuid
);

--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

--
-- Name: branches branches_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);

--
-- Name: configuration configuration_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.configuration
    ADD CONSTRAINT configuration_pkey PRIMARY KEY (key);

--
-- Name: member_number_sequences member_number_sequences_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.member_number_sequences
    ADD CONSTRAINT member_number_sequences_pkey PRIMARY KEY (branch_id);

--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);

--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);

--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

--
-- Name: subscription_items subscription_items_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscription_items
    ADD CONSTRAINT subscription_items_pkey PRIMARY KEY (id);

--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);

--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);

--
-- Name: idx_audit_log_change_id; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_audit_log_change_id ON fitfine.audit_log USING btree (change_id);

--
-- Name: idx_audit_log_changed_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_audit_log_changed_by ON fitfine.audit_log USING btree (changed_by);

--
-- Name: idx_audit_log_table_record; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_audit_log_table_record ON fitfine.audit_log USING btree (table_name, record_id);

--
-- Name: idx_branches_changed_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_branches_changed_by ON fitfine.branches USING btree (changed_by);

--
-- Name: idx_branches_code_active; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE UNIQUE INDEX idx_branches_code_active ON fitfine.branches USING btree (code) WHERE (deleted_at IS NULL);

--
-- Name: idx_branches_created_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_branches_created_by ON fitfine.branches USING btree (created_by);

--
-- Name: idx_branches_deleted_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_branches_deleted_by ON fitfine.branches USING btree (deleted_by);

--
-- Name: idx_configuration_changed_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_configuration_changed_by ON fitfine.configuration USING btree (changed_by);

--
-- Name: idx_configuration_created_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_configuration_created_by ON fitfine.configuration USING btree (created_by);

--
-- Name: idx_members_branch_id; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_members_branch_id ON fitfine.members USING btree (branch_id);

--
-- Name: idx_members_changed_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_members_changed_by ON fitfine.members USING btree (changed_by);

--
-- Name: idx_members_created_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_members_created_by ON fitfine.members USING btree (created_by);

--
-- Name: idx_members_deleted_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_members_deleted_by ON fitfine.members USING btree (deleted_by);

--
-- Name: idx_members_handled_by_staff; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_members_handled_by_staff ON fitfine.members USING btree (handled_by_staff);

--
-- Name: idx_members_number_active; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE UNIQUE INDEX idx_members_number_active ON fitfine.members USING btree (member_number) WHERE (deleted_at IS NULL);

--
-- Name: idx_members_phone_active; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE UNIQUE INDEX idx_members_phone_active ON fitfine.members USING btree (phone) WHERE (deleted_at IS NULL);

--
-- Name: idx_plans_category; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_plans_category ON fitfine.plans USING btree (category);

--
-- Name: idx_plans_changed_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_plans_changed_by ON fitfine.plans USING btree (changed_by);

--
-- Name: idx_plans_created_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_plans_created_by ON fitfine.plans USING btree (created_by);

--
-- Name: idx_plans_deleted_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_plans_deleted_by ON fitfine.plans USING btree (deleted_by);

--
-- Name: idx_plans_name_active; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE UNIQUE INDEX idx_plans_name_active ON fitfine.plans USING btree (name) WHERE (deleted_at IS NULL);

--
-- Name: idx_profiles_changed_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_profiles_changed_by ON fitfine.profiles USING btree (changed_by);

--
-- Name: idx_profiles_created_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_profiles_created_by ON fitfine.profiles USING btree (created_by);

--
-- Name: idx_profiles_deleted_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_profiles_deleted_by ON fitfine.profiles USING btree (deleted_by);

--
-- Name: idx_roles_changed_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_roles_changed_by ON fitfine.roles USING btree (changed_by);

--
-- Name: idx_roles_created_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_roles_created_by ON fitfine.roles USING btree (created_by);

--
-- Name: idx_roles_deleted_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_roles_deleted_by ON fitfine.roles USING btree (deleted_by);

--
-- Name: idx_roles_name_active; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE UNIQUE INDEX idx_roles_name_active ON fitfine.roles USING btree (name) WHERE (deleted_at IS NULL);

--
-- Name: idx_subscription_items_changed_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscription_items_changed_by ON fitfine.subscription_items USING btree (changed_by);

--
-- Name: idx_subscription_items_created_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscription_items_created_by ON fitfine.subscription_items USING btree (created_by);

--
-- Name: idx_subscription_items_deleted_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscription_items_deleted_by ON fitfine.subscription_items USING btree (deleted_by);

--
-- Name: idx_subscription_items_member_end; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscription_items_member_end ON fitfine.subscription_items USING btree (member_id, end_date) WHERE (deleted_at IS NULL);

--
-- Name: idx_subscription_items_plan_id; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscription_items_plan_id ON fitfine.subscription_items USING btree (plan_id);

--
-- Name: idx_subscription_items_shared_member_end; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscription_items_shared_member_end ON fitfine.subscription_items USING btree (shared_member_id, end_date) WHERE ((deleted_at IS NULL) AND (shared_member_id IS NOT NULL));

--
-- Name: idx_subscription_items_subscription_id; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscription_items_subscription_id ON fitfine.subscription_items USING btree (subscription_id);

--
-- Name: idx_subscriptions_changed_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscriptions_changed_by ON fitfine.subscriptions USING btree (changed_by);

--
-- Name: idx_subscriptions_created_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscriptions_created_by ON fitfine.subscriptions USING btree (created_by);

--
-- Name: idx_subscriptions_deleted_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscriptions_deleted_by ON fitfine.subscriptions USING btree (deleted_by);

--
-- Name: idx_subscriptions_member_id; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_subscriptions_member_id ON fitfine.subscriptions USING btree (member_id);

--
-- Name: idx_user_roles_granted_by; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_user_roles_granted_by ON fitfine.user_roles USING btree (granted_by);

--
-- Name: idx_user_roles_role_id; Type: INDEX; Schema: fitfine; Owner: -
--

CREATE INDEX idx_user_roles_role_id ON fitfine.user_roles USING btree (role_id);

--
-- Name: audit_log trg_audit_log_no_hard_delete; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_audit_log_no_hard_delete BEFORE DELETE ON fitfine.audit_log FOR EACH ROW EXECUTE FUNCTION fitfine.prevent_hard_delete();

--
-- Name: branches trg_branches_audit; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_branches_audit BEFORE INSERT OR UPDATE ON fitfine.branches FOR EACH ROW EXECUTE FUNCTION fitfine.set_audit_fields();

--
-- Name: branches trg_branches_audit_fields; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_branches_audit_fields AFTER INSERT OR UPDATE ON fitfine.branches FOR EACH ROW EXECUTE FUNCTION fitfine.audit_row_changes();

--
-- Name: branches trg_branches_no_hard_delete; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_branches_no_hard_delete BEFORE DELETE ON fitfine.branches FOR EACH ROW EXECUTE FUNCTION fitfine.prevent_hard_delete();

--
-- Name: members trg_members_audit; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_members_audit BEFORE INSERT OR UPDATE ON fitfine.members FOR EACH ROW EXECUTE FUNCTION fitfine.set_audit_fields();

--
-- Name: members trg_members_audit_fields; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_members_audit_fields AFTER INSERT OR UPDATE ON fitfine.members FOR EACH ROW EXECUTE FUNCTION fitfine.audit_row_changes();

--
-- Name: members trg_members_generate_number; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_members_generate_number BEFORE INSERT OR UPDATE ON fitfine.members FOR EACH ROW EXECUTE FUNCTION fitfine.generate_member_number();

--
-- Name: members trg_members_no_hard_delete; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_members_no_hard_delete BEFORE DELETE ON fitfine.members FOR EACH ROW EXECUTE FUNCTION fitfine.prevent_hard_delete();

--
-- Name: plans trg_plans_audit; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_plans_audit BEFORE INSERT OR UPDATE ON fitfine.plans FOR EACH ROW EXECUTE FUNCTION fitfine.set_audit_fields();

--
-- Name: plans trg_plans_audit_fields; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_plans_audit_fields AFTER INSERT OR UPDATE ON fitfine.plans FOR EACH ROW EXECUTE FUNCTION fitfine.audit_row_changes();

--
-- Name: plans trg_plans_no_hard_delete; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_plans_no_hard_delete BEFORE DELETE ON fitfine.plans FOR EACH ROW EXECUTE FUNCTION fitfine.prevent_hard_delete();

--
-- Name: profiles trg_profiles_audit; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_profiles_audit BEFORE INSERT OR UPDATE ON fitfine.profiles FOR EACH ROW EXECUTE FUNCTION fitfine.set_audit_fields();

--
-- Name: profiles trg_profiles_audit_fields; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_profiles_audit_fields AFTER INSERT OR UPDATE ON fitfine.profiles FOR EACH ROW EXECUTE FUNCTION fitfine.audit_row_changes();

--
-- Name: profiles trg_profiles_no_hard_delete; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_profiles_no_hard_delete BEFORE DELETE ON fitfine.profiles FOR EACH ROW EXECUTE FUNCTION fitfine.prevent_hard_delete();

--
-- Name: roles trg_roles_audit; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_roles_audit BEFORE INSERT OR UPDATE ON fitfine.roles FOR EACH ROW EXECUTE FUNCTION fitfine.set_audit_fields();

--
-- Name: roles trg_roles_audit_fields; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_roles_audit_fields AFTER INSERT OR UPDATE ON fitfine.roles FOR EACH ROW EXECUTE FUNCTION fitfine.audit_row_changes();

--
-- Name: roles trg_roles_no_hard_delete; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_roles_no_hard_delete BEFORE DELETE ON fitfine.roles FOR EACH ROW EXECUTE FUNCTION fitfine.prevent_hard_delete();

--
-- Name: roles trg_roles_protect_system_admin; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_roles_protect_system_admin BEFORE UPDATE ON fitfine.roles FOR EACH ROW EXECUTE FUNCTION fitfine.protect_system_admin_role();

--
-- Name: subscription_items trg_subscription_items_audit; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_subscription_items_audit BEFORE INSERT OR UPDATE ON fitfine.subscription_items FOR EACH ROW EXECUTE FUNCTION fitfine.set_audit_fields();

--
-- Name: subscription_items trg_subscription_items_audit_fields; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_subscription_items_audit_fields AFTER INSERT OR UPDATE ON fitfine.subscription_items FOR EACH ROW EXECUTE FUNCTION fitfine.audit_row_changes();

--
-- Name: subscription_items trg_subscription_items_no_hard_delete; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_subscription_items_no_hard_delete BEFORE DELETE ON fitfine.subscription_items FOR EACH ROW EXECUTE FUNCTION fitfine.prevent_hard_delete();

--
-- Name: subscriptions trg_subscriptions_audit; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_subscriptions_audit BEFORE INSERT OR UPDATE ON fitfine.subscriptions FOR EACH ROW EXECUTE FUNCTION fitfine.set_audit_fields();

--
-- Name: subscriptions trg_subscriptions_audit_fields; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_subscriptions_audit_fields AFTER INSERT OR UPDATE ON fitfine.subscriptions FOR EACH ROW EXECUTE FUNCTION fitfine.audit_row_changes();

--
-- Name: subscriptions trg_subscriptions_no_hard_delete; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_subscriptions_no_hard_delete BEFORE DELETE ON fitfine.subscriptions FOR EACH ROW EXECUTE FUNCTION fitfine.prevent_hard_delete();

--
-- Name: user_roles trg_user_roles_audit_fields; Type: TRIGGER; Schema: fitfine; Owner: -
--

CREATE TRIGGER trg_user_roles_audit_fields AFTER INSERT OR DELETE ON fitfine.user_roles FOR EACH ROW EXECUTE FUNCTION fitfine.audit_row_changes();

--
-- Name: audit_log audit_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.audit_log
    ADD CONSTRAINT audit_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES fitfine.profiles(id);

--
-- Name: branches branches_changed_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.branches
    ADD CONSTRAINT branches_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES fitfine.profiles(id);

--
-- Name: branches branches_created_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.branches
    ADD CONSTRAINT branches_created_by_fkey FOREIGN KEY (created_by) REFERENCES fitfine.profiles(id);

--
-- Name: branches branches_deleted_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.branches
    ADD CONSTRAINT branches_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES fitfine.profiles(id);

--
-- Name: configuration configuration_changed_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.configuration
    ADD CONSTRAINT configuration_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES fitfine.profiles(id);

--
-- Name: configuration configuration_created_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.configuration
    ADD CONSTRAINT configuration_created_by_fkey FOREIGN KEY (created_by) REFERENCES fitfine.profiles(id);

--
-- Name: member_number_sequences member_number_sequences_branch_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.member_number_sequences
    ADD CONSTRAINT member_number_sequences_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES fitfine.branches(id);

--
-- Name: members members_branch_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.members
    ADD CONSTRAINT members_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES fitfine.branches(id);

--
-- Name: members members_changed_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.members
    ADD CONSTRAINT members_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES fitfine.profiles(id);

--
-- Name: members members_created_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.members
    ADD CONSTRAINT members_created_by_fkey FOREIGN KEY (created_by) REFERENCES fitfine.profiles(id);

--
-- Name: members members_deleted_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.members
    ADD CONSTRAINT members_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES fitfine.profiles(id);

--
-- Name: members members_handled_by_staff_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.members
    ADD CONSTRAINT members_handled_by_staff_fkey FOREIGN KEY (handled_by_staff) REFERENCES fitfine.profiles(id);

--
-- Name: plans plans_changed_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.plans
    ADD CONSTRAINT plans_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES fitfine.profiles(id);

--
-- Name: plans plans_created_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.plans
    ADD CONSTRAINT plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES fitfine.profiles(id);

--
-- Name: plans plans_deleted_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.plans
    ADD CONSTRAINT plans_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES fitfine.profiles(id);

--
-- Name: profiles profiles_changed_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.profiles
    ADD CONSTRAINT profiles_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES fitfine.profiles(id);

--
-- Name: profiles profiles_created_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.profiles
    ADD CONSTRAINT profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES fitfine.profiles(id);

--
-- Name: profiles profiles_deleted_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.profiles
    ADD CONSTRAINT profiles_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES fitfine.profiles(id);

--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id);

--
-- Name: roles roles_changed_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.roles
    ADD CONSTRAINT roles_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES fitfine.profiles(id);

--
-- Name: roles roles_created_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.roles
    ADD CONSTRAINT roles_created_by_fkey FOREIGN KEY (created_by) REFERENCES fitfine.profiles(id);

--
-- Name: roles roles_deleted_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.roles
    ADD CONSTRAINT roles_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES fitfine.profiles(id);

--
-- Name: subscription_items subscription_items_changed_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscription_items
    ADD CONSTRAINT subscription_items_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES fitfine.profiles(id);

--
-- Name: subscription_items subscription_items_created_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscription_items
    ADD CONSTRAINT subscription_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES fitfine.profiles(id);

--
-- Name: subscription_items subscription_items_deleted_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscription_items
    ADD CONSTRAINT subscription_items_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES fitfine.profiles(id);

--
-- Name: subscription_items subscription_items_member_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscription_items
    ADD CONSTRAINT subscription_items_member_id_fkey FOREIGN KEY (member_id) REFERENCES fitfine.members(id);

--
-- Name: subscription_items subscription_items_plan_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscription_items
    ADD CONSTRAINT subscription_items_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES fitfine.plans(id) ON DELETE RESTRICT;

--
-- Name: subscription_items subscription_items_shared_member_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscription_items
    ADD CONSTRAINT subscription_items_shared_member_id_fkey FOREIGN KEY (shared_member_id) REFERENCES fitfine.members(id);

--
-- Name: subscription_items subscription_items_subscription_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscription_items
    ADD CONSTRAINT subscription_items_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES fitfine.subscriptions(id);

--
-- Name: subscriptions subscriptions_changed_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscriptions
    ADD CONSTRAINT subscriptions_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES fitfine.profiles(id);

--
-- Name: subscriptions subscriptions_created_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscriptions
    ADD CONSTRAINT subscriptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES fitfine.profiles(id);

--
-- Name: subscriptions subscriptions_deleted_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscriptions
    ADD CONSTRAINT subscriptions_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES fitfine.profiles(id);

--
-- Name: subscriptions subscriptions_member_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.subscriptions
    ADD CONSTRAINT subscriptions_member_id_fkey FOREIGN KEY (member_id) REFERENCES fitfine.members(id);

--
-- Name: user_roles user_roles_granted_by_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.user_roles
    ADD CONSTRAINT user_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES fitfine.profiles(id);

--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES fitfine.roles(id);

--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: fitfine; Owner: -
--

ALTER TABLE ONLY fitfine.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitfine.profiles(id);

--
-- Name: audit_log; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: branches; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.branches ENABLE ROW LEVEL SECURITY;

--
-- Name: configuration; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.configuration ENABLE ROW LEVEL SECURITY;

--
-- Name: member_number_sequences; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.member_number_sequences ENABLE ROW LEVEL SECURITY;

--
-- Name: members; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.members ENABLE ROW LEVEL SECURITY;

--
-- Name: plans; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.plans ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_items; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.subscription_items ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: fitfine; Owner: -
--

ALTER TABLE fitfine.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: users trg_handle_new_auth_user; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER trg_handle_new_auth_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION fitfine.handle_new_auth_user();
