import { setupContext } from '../../shared/setupAccess.ts';
import { registrationInput, validateRegistration } from '../../shared/a2pRegistration.ts';
import { completeRegistration } from '../../shared/a2pProgram.ts';
import { failure } from '../../shared/ghl.ts';
export default async function (req: Request) {
  try {
    const { E, s } = await setupContext(req);
    const input = await req.json();
    const data = await completeRegistration(req, E, s, registrationInput(input));
    const errors = validateRegistration(data, data.business_type === 'company' ? { ein: input.ein ?? '' } : {});
    return Response.json({ valid: !errors.length, errors });
  } catch (e) { return failure(e as Error); }
}
