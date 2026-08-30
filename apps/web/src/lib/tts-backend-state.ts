export type Backend = "gpu" | "cpu";

export type BackendCircuitState = {
  active: Backend;
  consecutiveProbeFails: number;
};

export const PRIMARY_FAIL_THRESHOLD = 3;

/**
 * Apply the result of a primary-backend probe.
 *
 * Three consecutive failures open the circuit and select the CPU fallback.
 * One successful primary probe closes it and returns traffic to the GPU.
 */
export function afterPrimaryProbe(
  current: BackendCircuitState,
  succeeded: boolean,
): BackendCircuitState {
  if (succeeded) {
    return { active: "gpu", consecutiveProbeFails: 0 };
  }

  const consecutiveProbeFails = current.consecutiveProbeFails + 1;
  return {
    active:
      current.active === "gpu" &&
      consecutiveProbeFails >= PRIMARY_FAIL_THRESHOLD
        ? "cpu"
        : current.active,
    consecutiveProbeFails,
  };
}

/**
 * Record a user-request result without changing the selected backend.
 * The active probe, rather than one request, owns circuit transitions.
 */
export function afterRequest(current: BackendCircuitState): BackendCircuitState {
  return { ...current };
}
