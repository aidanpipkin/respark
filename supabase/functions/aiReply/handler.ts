import { adminContext } from '../_shared/agentAccess.ts';
import { failure } from '../_shared/ghl.ts';
import { replyToInbound } from '../_shared/aiReplyCore.ts';
export default async function (req: Request) {
  try { const { base44 } = await adminContext(req); const input = await req.json(); return Response.json(await replyToInbound(base44, input.message_log_id)); }
  catch (error) { return failure(error as Error); }
}
