import { NextResponse } from "next/server";
import { sendWebPush } from "@/lib/push/send-web-push";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type DueStudyReminder = {
  reminder_interval_minutes: number;
  session_id: string;
  started_at: string;
  user_id: string;
};

type LongStudySessionCheck = {
  session_id: string;
  started_at: string;
  user_id: string;
};

type StoppedStudySession = {
  ended_at: string;
  session_id: string;
  started_at: string;
  user_id: string;
};

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Unauthorized." }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { message: "Supabase is not configured." },
      { status: 503 },
    );
  }

  // Stop overlong sessions first so a 12h+ timer never also gets a check-in.
  const stoppedResult = await admin.rpc("stop_overlong_study_sessions", {
    batch_size: 100,
  });

  if (stoppedResult.error) {
    return NextResponse.json(
      { message: stoppedResult.error.message },
      { status: 500 },
    );
  }

  const checksResult = await admin.rpc("claim_long_study_session_checks", {
    batch_size: 100,
  });

  if (checksResult.error) {
    return NextResponse.json(
      { message: checksResult.error.message },
      { status: 500 },
    );
  }

  const { data, error } = await admin.rpc("claim_due_study_reminders", {
    batch_size: 100,
  });

  if (error) {
    return NextResponse.json({ message: error.message }, { status: 500 });
  }

  const stoppedSessions = (stoppedResult.data ?? []) as StoppedStudySession[];
  const longSessionChecks = (checksResult.data ?? []) as LongStudySessionCheck[];
  const checkedSessionIds = new Set(
    longSessionChecks.map((check) => check.session_id),
  );
  // The 8h check already asks "still studying?", so skip a same-run reminder.
  const reminders = ((data ?? []) as DueStudyReminder[]).filter(
    (reminder) => !checkedSessionIds.has(reminder.session_id),
  );
  const deliveries = await Promise.allSettled([
    ...stoppedSessions.map((session) =>
      sendWebPush({
        body: "Your timer ran for 12 hours, so we stopped it. Tap to review the session.",
        category: "study_reminder",
        tag: `mac-study-reminder-${session.session_id}`,
        title: "Study session stopped",
        url: "/app",
        userId: session.user_id,
      }),
    ),
    ...longSessionChecks.map((check) =>
      sendWebPush({
        body: `Your timer has been running for ${formatElapsed(check.started_at)}. It stops automatically at 12 hours.`,
        category: "study_reminder",
        tag: `mac-study-reminder-${check.session_id}`,
        title: "Still studying?",
        url: "/app?study-reminder=check",
        userId: check.user_id,
      }),
    ),
    ...reminders.map((reminder) =>
      sendWebPush({
        body: `Your timer has been running for ${formatElapsed(reminder.started_at)}. Tap to check in.`,
        category: "study_reminder",
        tag: `mac-study-reminder-${reminder.session_id}`,
        title: "Still studying?",
        url: "/app?study-reminder=check",
        userId: reminder.user_id,
      }),
    ),
  ]);
  const delivered = deliveries.reduce(
    (count, delivery) =>
      count + (delivery.status === "fulfilled" ? delivery.value.sent : 0),
    0,
  );

  return NextResponse.json({
    claimed: reminders.length,
    delivered,
    longSessionChecks: longSessionChecks.length,
    stopped: stoppedSessions.length,
  });
}

function isAuthorized(request: Request) {
  const secret = process.env.STUDY_REMINDER_CRON_SECRET;
  if (!secret) return false;

  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function formatElapsed(startedAt: string) {
  const elapsedMinutes = Math.max(
    1,
    Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000),
  );

  if (elapsedMinutes < 60) return `${elapsedMinutes} minutes`;

  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}
