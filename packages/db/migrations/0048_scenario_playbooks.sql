CREATE TABLE IF NOT EXISTS "scenario_playbooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "description" text,
  "raw_text" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "execution_mode" text DEFAULT 'signal_only' NOT NULL,
  "trigger" jsonb NOT NULL,
  "confirmation" jsonb NOT NULL,
  "actions" jsonb NOT NULL,
  "last_checked_at" timestamp with time zone,
  "last_evaluation" jsonb,
  "triggered_at" timestamp with time zone,
  "trigger_evidence" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "scenario_playbooks_user_idx" ON "scenario_playbooks" ("user_id");
CREATE INDEX IF NOT EXISTS "scenario_playbooks_status_idx" ON "scenario_playbooks" ("status");

CREATE TABLE IF NOT EXISTS "scenario_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "playbook_id" uuid NOT NULL REFERENCES "scenario_playbooks"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "matched" boolean DEFAULT false NOT NULL,
  "summary" text NOT NULL,
  "evidence" jsonb,
  "actions_taken" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "scenario_runs_playbook_idx" ON "scenario_runs" ("playbook_id", "created_at");
CREATE INDEX IF NOT EXISTS "scenario_runs_user_idx" ON "scenario_runs" ("user_id", "created_at");
