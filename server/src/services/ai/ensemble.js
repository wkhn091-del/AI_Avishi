/**
 * Mixture of experts for project summaries.
 *
 * Every ensemble provider gets the same prompt at once (Promise.allSettled).
 * The answers that pass validation go to a synthesizer model, which merges them
 * into one final answer. A provider that fails (after its own retries) is
 * skipped; the ensemble only fails when every provider failed. If no provider
 * manages the synthesis, the answer of the most preferred provider is used.
 */
import { allFailed, completeJson, modelOf } from './llmClient.js';
import { providerById } from './providers.js';

/**
 * @param {{ system: string, prompt: string, members: string[], synthesizer?: string,
 *           validate: (data: object) => object,
 *           synthesis: { system: string, prompt: (candidates: string) => string } }} input
 * @returns {Promise<{ data: object, provider: string, model: string, ensemble: object }>}
 */
export async function runEnsemble({ system, prompt, members, synthesizer, validate, synthesis }) {
  const settled = await Promise.allSettled(
    members.map((id) => completeJson({ system, prompt, provider: id }).then((result) => ({ ...result, answer: validate(result.data) }))),
  );
  const contributions = settled.map((outcome, index) => {
    const provider = providerById(members[index]);
    if (outcome.status === 'fulfilled') {
      return { provider: provider.id, name: provider.name, model: outcome.value.model, ok: true, ms: outcome.value.ms, answer: outcome.value.answer };
    }
    const error = outcome.reason;
    console.warn(`[ai] Ensemble: ${provider.name} failed: ${error?.log ?? error?.message}`);
    return {
      provider: provider.id,
      name: provider.name,
      model: modelOf(provider.id),
      ok: false,
      message: error?.message ?? String(error),
      detail: error?.detail ?? null,
      code: error?.code ?? 'AI_FAILED',
      error,
    };
  });

  const answered = contributions.filter((contribution) => contribution.ok);
  const members_ = contributions.map(({ answer, error, ...rest }) => rest);
  if (!answered.length) throw allFailed(contributions);
  if (answered.length === 1) {
    const [only] = answered;
    return { data: only.answer, provider: only.provider, model: only.model, ensemble: { members: members_, synthesizer: null } };
  }

  const candidates = answered.map((contribution, index) => `Candidate ${index + 1} (${contribution.name}):\n${JSON.stringify(contribution.answer)}`).join('\n\n');
  const synthesizerFailed = contributions.some((contribution) => contribution.provider === synthesizer && !contribution.ok);
  const order = [...new Set([...(synthesizer && !synthesizerFailed ? [synthesizer] : []), ...answered.map((contribution) => contribution.provider)])];
  for (const id of order) {
    try {
      const result = await completeJson({ system: synthesis.system, prompt: synthesis.prompt(candidates), provider: id });
      const data = validate(result.data);
      return {
        data,
        provider: result.provider,
        model: result.model,
        ensemble: { members: members_, synthesizer: { provider: result.provider, name: result.providerName, model: result.model } },
      };
    } catch (error) {
      console.warn(`[ai] Ensemble: merging with ${providerById(id)?.name ?? id} failed: ${error.log ?? error.message}`);
    }
  }
  const [best] = answered;
  return { data: best.answer, provider: best.provider, model: best.model, ensemble: { members: members_, synthesizer: null, synthesisFailed: true } };
}
