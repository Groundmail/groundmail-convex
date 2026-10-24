/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      cancelEmail: FunctionReference<
        "mutation",
        "internal",
        { emailId: string },
        boolean,
        Name
      >;
      cleanupOldEmails: FunctionReference<
        "mutation",
        "internal",
        { olderThan?: number },
        null,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { emailId: string },
        {
          attachments?: Array<{
            contentId?: string;
            contentType?: string;
            filename: string;
          }>;
          attempts: number;
          bcc?: Array<string>;
          bounceType: string | null;
          category?: "transactional" | "product" | "newsletter";
          cc?: Array<string>;
          clicked: boolean;
          complained: boolean;
          createdAt: number;
          errorCode: string | null;
          errorMessage: string | null;
          from: string | { email: string; name?: string };
          groundmailId: string | null;
          headers?: Record<string, string>;
          heldBack: Array<{ email: string; reason: string }> | null;
          html?: string;
          id: string;
          idempotencyKey: string;
          opened: boolean;
          replyTo?: Array<string>;
          scheduledAt?: string;
          status:
            | "queued"
            | "sending"
            | "scheduled"
            | "sent"
            | "delivered"
            | "delivery_delayed"
            | "held"
            | "bounced"
            | "failed"
            | "suppressed"
            | "cancelled"
            | "unknown";
          subject?: string;
          tags?: Array<{ name: string; value: string }>;
          template?: {
            id: string;
            variables?: Record<string, string | number | boolean>;
          };
          tenant?: string;
          test: boolean;
          text?: string;
          to: Array<string>;
          unsubscribe?: boolean;
        } | null,
        Name
      >;
      getByGroundmailId: FunctionReference<
        "query",
        "internal",
        { groundmailId: string },
        {
          attachments?: Array<{
            contentId?: string;
            contentType?: string;
            filename: string;
          }>;
          attempts: number;
          bcc?: Array<string>;
          bounceType: string | null;
          category?: "transactional" | "product" | "newsletter";
          cc?: Array<string>;
          clicked: boolean;
          complained: boolean;
          createdAt: number;
          errorCode: string | null;
          errorMessage: string | null;
          from: string | { email: string; name?: string };
          groundmailId: string | null;
          headers?: Record<string, string>;
          heldBack: Array<{ email: string; reason: string }> | null;
          html?: string;
          id: string;
          idempotencyKey: string;
          opened: boolean;
          replyTo?: Array<string>;
          scheduledAt?: string;
          status:
            | "queued"
            | "sending"
            | "scheduled"
            | "sent"
            | "delivered"
            | "delivery_delayed"
            | "held"
            | "bounced"
            | "failed"
            | "suppressed"
            | "cancelled"
            | "unknown";
          subject?: string;
          tags?: Array<{ name: string; value: string }>;
          template?: {
            id: string;
            variables?: Record<string, string | number | boolean>;
          };
          tenant?: string;
          test: boolean;
          text?: string;
          to: Array<string>;
          unsubscribe?: boolean;
        } | null,
        Name
      >;
      handleEmailEvent: FunctionReference<
        "mutation",
        "internal",
        { event: { created_at: string; data: any; type: string } },
        null,
        Name
      >;
      sendEmail: FunctionReference<
        "mutation",
        "internal",
        {
          attachments?: Array<{
            content: string;
            contentId?: string;
            contentType?: string;
            filename: string;
          }>;
          bcc?: Array<string>;
          category?: "transactional" | "product" | "newsletter";
          cc?: Array<string>;
          from: string | { email: string; name?: string };
          headers?: Record<string, string>;
          html?: string;
          idempotencyKey?: string;
          options: {
            apiKey: string;
            baseUrl: string;
            initialBackoffMs: number;
            onEmailEvent?: { fnHandle: string };
            retryAttempts: number;
          };
          replyTo?: Array<string>;
          scheduledAt?: string;
          subject?: string;
          tags?: Array<{ name: string; value: string }>;
          template?: {
            id: string;
            variables?: Record<string, string | number | boolean>;
          };
          tenant?: string;
          text?: string;
          to: Array<string>;
          unsubscribe?: boolean;
        },
        string,
        Name
      >;
    };
  };
