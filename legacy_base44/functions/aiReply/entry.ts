import { adminContext } from '../../shared/agentAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { replyToInbound } from '../../shared/aiReplyCore.ts';
export default async function (req: Request) {
  try { const { base44 } = await adminContext(req); const input = await req.json(); return Response.json(await replyToInbound(base44, input.message_log_id)); }
  catch (error) { return failure(error as Error); }
}
