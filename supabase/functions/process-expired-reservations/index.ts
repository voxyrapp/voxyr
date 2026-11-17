import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!serviceRoleKey || req.headers.get("Authorization") !== `Bearer ${serviceRoleKey}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceRoleKey
    );

    const { data, error } = await supabase.rpc("cancel_expired_reservations");

    if (error) {
      console.error("RPC cancel_expired_reservations error:", error);
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }

    const processed = Array.isArray(data) ? data : [];
    const notificationErrors = [];

    for (const item of processed) {
      const { user_id, slot_id, cancel_reason } = item;

      const { error: cancellationError } = await supabase.functions.invoke(
        "notify-reservation-cancelled",
        {
          body: { user_id, slot_id, reason: cancel_reason }
        }
      );

      if (cancellationError) {
        console.error("Cancellation notification failed:", cancellationError);
        notificationErrors.push({
          user_id,
          type: "notify-reservation-cancelled",
          error: cancellationError.message
        });
      }

      const { error: slotError } = await supabase.functions.invoke(
        "notify-new-slot",
        {
          body: { slot_id, exclude_user_id: user_id }
        }
      );

      if (slotError) {
        console.error("New slot notification failed:", slotError);
        notificationErrors.push({
          user_id,
          type: "notify-new-slot",
          error: slotError.message
        });
      }
    }

    return Response.json({
      ok: true,
      processed_count: processed.length,
      notification_errors: notificationErrors.length,
      processed
    });
  } catch (e) {
    console.error("Unexpected error:", e);
    return Response.json({ ok: false, message: String(e) }, { status: 500 });
  }
});
