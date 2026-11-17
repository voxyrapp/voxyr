import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function authenticateRequest(req: Request, supabase: any) {
  const authHeader = req.headers.get("Authorization") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  // Permite chamadas internas autenticadas com a chave de serviço.
  if (serviceKey && authHeader === `Bearer ${serviceKey}`) {
    return { ok: true, internal: true, user: null, profile: null };
  }

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return { ok: false, status: 401, error: "Autenticação obrigatória" };
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return { ok: false, status: 401, error: "Sessão inválida ou expirada" };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, store_id, status")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return { ok: false, status: 403, error: "Perfil não autorizado" };
  }

  return {
    ok: true,
    internal: false,
    user: data.user,
    profile
  };
}

export function jsonError(message: string, status = 403, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({ ok: false, error: message }),
    {
      status,
      headers: {
        ...headers,
        "Content-Type": "application/json"
      }
    }
  );
}
