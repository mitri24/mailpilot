CREATE TABLE "change_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"op" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarification_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid,
	"message_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"question" text NOT NULL,
	"reason" text NOT NULL,
	"excerpt" text,
	"subject" text,
	"options" jsonb NOT NULL,
	"allow_free_text" boolean DEFAULT true NOT NULL,
	"dedupe_key" text NOT NULL,
	"analysis_id" uuid,
	"action_index" integer,
	"answer_option_id" text,
	"answer_text" text,
	"answer_scope" text,
	"answered_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"email_address" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"credentials_enc" text,
	"imap_host" text,
	"imap_port" integer,
	"imap_secure" boolean,
	"imap_username" text,
	"capabilities" jsonb,
	"marker_strategy" text DEFAULT 'none' NOT NULL,
	"marker_keyword" text,
	"marker_folder" text,
	"marker_acknowledged" boolean DEFAULT false NOT NULL,
	"initial_import_days" integer DEFAULT 14 NOT NULL,
	"include_sent" boolean DEFAULT true NOT NULL,
	"last_successful_fetch_at" timestamp with time zone,
	"last_successful_analysis_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"last_error_action" text,
	"last_error_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mail_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_folder_id" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'other' NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"imap_uidvalidity" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marker_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"task_id" uuid,
	"operation" text NOT NULL,
	"strategy" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text NOT NULL,
	"output" jsonb,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"imap_uidvalidity" bigint,
	"imap_uid" bigint,
	"provider_location_id" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid,
	"identity_key" text NOT NULL,
	"provider_message_id" text,
	"rfc_message_id" text,
	"in_reply_to" text,
	"references_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_address" text,
	"from_name" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"language" text,
	"body_text" text DEFAULT '' NOT NULL,
	"body_html" text,
	"remote_content_blocked" integer DEFAULT 0 NOT NULL,
	"snippet" text,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"size_bytes" integer,
	"content_hash" text NOT NULL,
	"headers_fingerprint" text,
	"web_link" text,
	"is_from_me" boolean DEFAULT false NOT NULL,
	"analysis_status" text DEFAULT 'pending' NOT NULL,
	"analysis_content_hash" text,
	"analysis_attempts" integer DEFAULT 0 NOT NULL,
	"analysis_error" text,
	"analyzed_at" timestamp with time zone,
	"marker_status" text DEFAULT 'not_requested' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mutation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications_sent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state" text NOT NULL,
	"code_verifier" text NOT NULL,
	"access" text DEFAULT 'read' NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "oauth_states_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "processing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{"fetched":0,"newMessages":0,"updatedMessages":0,"analyzed":0,"tasksCreated":0,"tasksUpdated":0,"clarifications":0,"skipped":0,"budgetPaused":0,"errors":0}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"environment" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "push_devices_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_name" text,
	"platform" text,
	"dev_login" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"folder_id" uuid,
	"kind" text NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"title" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"message_id" uuid,
	"summary" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_task_id" uuid NOT NULL,
	"target_task_id" uuid NOT NULL,
	"moved_source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"moved_note_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"moved_checklist_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"source_status_before" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"conflict_of_note_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by" text NOT NULL,
	"action_key" text,
	"evidence_quotes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"change_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"waiting" boolean DEFAULT false NOT NULL,
	"waiting_check_at" date,
	"snoozed_until" timestamp with time zone,
	"planned_for" date,
	"sort_key" double precision,
	"ai_title" text,
	"ai_next_step" text,
	"ai_summary" text,
	"ai_priority" text,
	"ai_priority_reason" text,
	"ai_deadline_date" date,
	"ai_deadline_at" timestamp with time zone,
	"ai_deadline_precision" text,
	"ai_deadline_kind" text,
	"ai_deadline_quote" text,
	"ai_why" text,
	"ai_needs" text,
	"requires_attachment_reading" boolean DEFAULT false NOT NULL,
	"manual_title" text,
	"manual_next_step" text,
	"manual_priority" text,
	"manual_deadline_date" date,
	"manual_deadline_at" timestamp with time zone,
	"manual_deadline_precision" text,
	"manual_deadline_cleared" boolean DEFAULT false NOT NULL,
	"estimated_minutes" integer,
	"estimate_source" text,
	"latest_change" text,
	"done_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_reason" text,
	"status_before_dismiss" text,
	"merged_into_task_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_thread_id" text,
	"subject_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"applies" boolean NOT NULL,
	"note" text,
	"source_clarification_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apple_sub" text,
	"dev_email" text,
	"email" text,
	"display_name" text,
	"timezone" text DEFAULT 'Europe/Paris' NOT NULL,
	"scan_enabled" boolean DEFAULT true NOT NULL,
	"scan_time" text DEFAULT '07:00' NOT NULL,
	"extra_scan_interval_minutes" integer,
	"ai_monthly_budget_cents" integer DEFAULT 500 NOT NULL,
	"max_message_chars" integer DEFAULT 20000 NOT NULL,
	"max_attachment_bytes" integer DEFAULT 5000000 NOT NULL,
	"notify_daily_digest" boolean DEFAULT false NOT NULL,
	"notify_urgent_deadlines" boolean DEFAULT false NOT NULL,
	"notify_clarifications" boolean DEFAULT false NOT NULL,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"last_scheduled_scan_on" date,
	"last_extra_scan_at" timestamp with time zone,
	"last_digest_sent_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_apple_sub_unique" UNIQUE("apple_sub"),
	CONSTRAINT "users_dev_email_unique" UNIQUE("dev_email")
);
--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD CONSTRAINT "clarification_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD CONSTRAINT "clarification_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD CONSTRAINT "clarification_requests_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_folders" ADD CONSTRAINT "mail_folders_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker_operations" ADD CONSTRAINT "marker_operations_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker_operations" ADD CONSTRAINT "marker_operations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_analyses" ADD CONSTRAINT "message_analyses_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_analyses" ADD CONSTRAINT "message_analyses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_locations" ADD CONSTRAINT "message_locations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_locations" ADD CONSTRAINT "message_locations_folder_id_mail_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."mail_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_receipts" ADD CONSTRAINT "mutation_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications_sent" ADD CONSTRAINT "notifications_sent_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_folder_id_mail_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."mail_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_merges" ADD CONSTRAINT "task_merges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_merges" ADD CONSTRAINT "task_merges_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_merges" ADD CONSTRAINT "task_merges_target_task_id_tasks_id_fk" FOREIGN KEY ("target_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sources" ADD CONSTRAINT "task_sources_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sources" ADD CONSTRAINT "task_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_rules" ADD CONSTRAINT "user_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_log_user_seq_idx" ON "change_log" USING btree ("user_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "clarifications_user_dedupe_uq" ON "clarification_requests" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "clarifications_user_status_idx" ON "clarification_requests" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "mail_accounts_user_idx" ON "mail_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_user_address_uq" ON "mail_accounts" USING btree ("user_id","provider",lower("email_address")) WHERE "mail_accounts"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_folders_account_provider_uq" ON "mail_folders" USING btree ("account_id","provider_folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marker_operations_uq" ON "marker_operations" USING btree ("message_id","strategy","operation");--> statement-breakpoint
CREATE INDEX "message_analyses_user_month_idx" ON "message_analyses" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "message_analyses_message_idx" ON "message_analyses" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_locations_message_folder_uq" ON "message_locations" USING btree ("message_id","folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_locations_imap_uq" ON "message_locations" USING btree ("folder_id","imap_uidvalidity","imap_uid") WHERE "message_locations"."imap_uid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_identity_uq" ON "messages" USING btree ("account_id","identity_key");--> statement-breakpoint
CREATE INDEX "messages_account_sent_idx" ON "messages" USING btree ("account_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_rfc_idx" ON "messages" USING btree ("account_id","rfc_message_id");--> statement-breakpoint
CREATE INDEX "messages_analysis_idx" ON "messages" USING btree ("analysis_status");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mutation_receipts_uq" ON "mutation_receipts" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_sent_uq" ON "notifications_sent" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "processing_runs_user_idx" ON "processing_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_cursors_uq" ON "sync_cursors" USING btree ("account_id","kind",coalesce("folder_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "task_checklist_task_idx" ON "task_checklist_items" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_notes_task_idx" ON "task_notes" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_sources_task_message_uq" ON "task_sources" USING btree ("task_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_sources_message_action_uq" ON "task_sources" USING btree ("message_id","action_key") WHERE "task_sources"."action_key" is not null and "task_sources"."role" = 'origin';--> statement-breakpoint
CREATE INDEX "task_sources_message_idx" ON "task_sources" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "tasks_user_status_idx" ON "tasks" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "tasks_user_updated_idx" ON "tasks" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_account_provider_uq" ON "threads" USING btree ("account_id","provider_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_rules_subject_uq" ON "user_rules" USING btree ("user_id","kind",lower("subject")) WHERE "user_rules"."deleted_at" is null;