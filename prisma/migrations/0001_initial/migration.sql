-- ──────────────────────────────────────────────────────────────
-- Migration 0001_initial
-- Cria todas as tabelas do schema Chatplay Assistant v1
-- ──────────────────────────────────────────────────────────────

-- Enums
CREATE TYPE "UserRole"         AS ENUM ('AGENT', 'ADMIN', 'SUPER_ADMIN');
CREATE TYPE "SuggestionSource" AS ENUM ('AI', 'TEMPLATE', 'MANUAL');
CREATE TYPE "FeedbackType"     AS ENUM ('APPROVED', 'REJECTED', 'USED', 'IGNORED');

-- Organizations
CREATE TABLE "organizations" (
    "id"        TEXT         NOT NULL,
    "name"      TEXT         NOT NULL,
    "slug"      TEXT         NOT NULL,
    "settings"  JSONB        NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organizations_slug_key" UNIQUE ("slug")
);

-- Users
CREATE TABLE "users" (
    "id"             TEXT         NOT NULL,
    "organizationId" TEXT         NOT NULL,
    "email"          TEXT         NOT NULL,
    "passwordHash"   TEXT         NOT NULL,
    "name"           TEXT         NOT NULL,
    "role"           "UserRole"   NOT NULL DEFAULT 'AGENT',
    "isActive"       BOOLEAN      NOT NULL DEFAULT true,
    "lastSeenAt"     TIMESTAMPTZ,
    "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT "users_pkey"        PRIMARY KEY ("id"),
    CONSTRAINT "users_email_key"   UNIQUE ("email"),
    CONSTRAINT "users_org_fk"      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
);

-- Sessions
CREATE TABLE "sessions" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "token"     TEXT         NOT NULL,
    "expiresAt" TIMESTAMPTZ  NOT NULL,
    "createdAt" TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT "sessions_pkey"      PRIMARY KEY ("id"),
    CONSTRAINT "sessions_token_key" UNIQUE ("token"),
    CONSTRAINT "sessions_user_fk"   FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Suggestions
CREATE TABLE "suggestions" (
    "id"             TEXT              NOT NULL,
    "organizationId" TEXT              NOT NULL,
    "category"       TEXT              NOT NULL,
    "text"           TEXT              NOT NULL,
    "score"          DOUBLE PRECISION  NOT NULL DEFAULT 0,
    "usageCount"     INTEGER           NOT NULL DEFAULT 0,
    "source"         "SuggestionSource" NOT NULL DEFAULT 'AI',
    "createdAt"      TIMESTAMPTZ       NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ       NOT NULL DEFAULT now(),
    CONSTRAINT "suggestions_pkey"   PRIMARY KEY ("id"),
    CONSTRAINT "suggestions_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
);
CREATE INDEX "suggestions_org_cat_idx" ON "suggestions"("organizationId", "category");

-- Suggestion Feedback
CREATE TABLE "suggestion_feedback" (
    "id"           TEXT          NOT NULL,
    "suggestionId" TEXT          NOT NULL,
    "userId"       TEXT          NOT NULL,
    "type"         "FeedbackType" NOT NULL,
    "reason"       TEXT,
    "createdAt"    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT "suggestion_feedback_pkey"    PRIMARY KEY ("id"),
    CONSTRAINT "suggestion_feedback_sug_fk"  FOREIGN KEY ("suggestionId") REFERENCES "suggestions"("id") ON DELETE CASCADE,
    CONSTRAINT "suggestion_feedback_user_fk" FOREIGN KEY ("userId") REFERENCES "users"("id")
);
CREATE INDEX "sf_suggestion_idx" ON "suggestion_feedback"("suggestionId");
CREATE INDEX "sf_user_idx"       ON "suggestion_feedback"("userId");

-- Usage Events
CREATE TABLE "usage_events" (
    "id"             TEXT        NOT NULL,
    "organizationId" TEXT        NOT NULL,
    "userId"         TEXT,
    "eventType"      TEXT        NOT NULL,
    "payload"        JSONB       NOT NULL DEFAULT '{}',
    "ipAddress"      TEXT,
    "userAgent"      TEXT,
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "usage_events_pkey"   PRIMARY KEY ("id"),
    CONSTRAINT "usage_events_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
    CONSTRAINT "usage_events_usr_fk" FOREIGN KEY ("userId") REFERENCES "users"("id")
);
CREATE INDEX "ue_org_type_idx"  ON "usage_events"("organizationId", "eventType");
CREATE INDEX "ue_user_idx"      ON "usage_events"("userId");
CREATE INDEX "ue_created_idx"   ON "usage_events"("createdAt");

-- Templates
CREATE TABLE "templates" (
    "id"             TEXT              NOT NULL,
    "organizationId" TEXT              NOT NULL,
    "category"       TEXT              NOT NULL,
    "text"           TEXT              NOT NULL,
    "score"          DOUBLE PRECISION  NOT NULL DEFAULT 0,
    "usageCount"     INTEGER           NOT NULL DEFAULT 0,
    "isActive"       BOOLEAN           NOT NULL DEFAULT true,
    "createdAt"      TIMESTAMPTZ       NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ       NOT NULL DEFAULT now(),
    CONSTRAINT "templates_pkey"   PRIMARY KEY ("id"),
    CONSTRAINT "templates_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
);
CREATE INDEX "templates_org_cat_idx" ON "templates"("organizationId", "category");

-- Settings
CREATE TABLE "settings" (
    "id"             TEXT        NOT NULL,
    "organizationId" TEXT        NOT NULL,
    "key"            TEXT        NOT NULL,
    "value"          JSONB       NOT NULL,
    "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "settings_pkey"        PRIMARY KEY ("id"),
    CONSTRAINT "settings_org_key_idx" UNIQUE ("organizationId", "key"),
    CONSTRAINT "settings_org_fk"      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
);

-- Knowledge Bases
CREATE TABLE "knowledge_bases" (
    "id"             TEXT        NOT NULL,
    "organizationId" TEXT        NOT NULL,
    "name"           TEXT        NOT NULL,
    "sourceUrl"      TEXT,
    "content"        JSONB       NOT NULL DEFAULT '{}',
    "lastSyncedAt"   TIMESTAMPTZ,
    "isActive"       BOOLEAN     NOT NULL DEFAULT true,
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "knowledge_bases_pkey"   PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_bases_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
);
