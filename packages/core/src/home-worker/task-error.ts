/** A job that cannot become a task, or a result that cannot be applied: it fails permanently. */
export class TaskError extends Error {}
/** The machine's output was unusable: the job goes back in the queue (until its attempts run out). */
export class RetryableTaskError extends TaskError {}
