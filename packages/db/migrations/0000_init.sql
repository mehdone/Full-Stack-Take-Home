CREATE TABLE "sites" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"location_label" text,
	"timezone" text NOT NULL,
	"emission_limit" numeric(18, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_emission_points" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"site_id" bigint NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurements" (
	"id" bigserial NOT NULL,
	"site_id" bigint NOT NULL,
	"emission_point_id" bigint NOT NULL,
	"batch_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"value" numeric(18, 6) NOT NULL,
	CONSTRAINT "measurements_pkey" PRIMARY KEY("id","recorded_at")
);
--> statement-breakpoint
CREATE TABLE "site_monthly_emissions" (
	"site_id" bigint NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"total_kg" numeric(18, 6) DEFAULT '0' NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone,
	CONSTRAINT "site_monthly_emissions_pkey" PRIMARY KEY("site_id","year","month"),
	CONSTRAINT "site_monthly_emissions_month_range" CHECK ("site_monthly_emissions"."month" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "system_alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"alert_type" text NOT NULL,
	"severity" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_emission_points" ADD CONSTRAINT "site_emission_points_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_emission_point_id_site_emission_points_id_fk" FOREIGN KEY ("emission_point_id") REFERENCES "public"."site_emission_points"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_monthly_emissions" ADD CONSTRAINT "site_monthly_emissions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sites_slug_unique" ON "sites" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "site_emission_points_site_code_unique" ON "site_emission_points" USING btree ("site_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "measurements_batch_point_time_unique" ON "measurements" USING btree ("batch_id","emission_point_id","recorded_at");--> statement-breakpoint
CREATE INDEX "measurements_site_recorded_at_idx" ON "measurements" USING btree ("site_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "measurements_batch_id_idx" ON "measurements" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "site_monthly_emissions_stale_idx" ON "site_monthly_emissions" USING btree ("site_id","year","month") WHERE stale = true;--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("available_at") WHERE delivered_at IS NULL;--> statement-breakpoint
CREATE INDEX "system_alerts_pending_idx" ON "system_alerts" USING btree ("available_at") WHERE delivered_at IS NULL;