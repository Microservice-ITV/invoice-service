export class RabbitConsumerLifecycle {
  private initialized = false;
  private initializing: Promise<void> | null = null;

  constructor(private readonly initialize: () => Promise<void>) {}

  start(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;

    const initialization = this.initialize()
      .then(() => {
        this.initialized = true;
      })
      .finally(() => {
        if (this.initializing === initialization) {
          this.initializing = null;
        }
      });
    this.initializing = initialization;
    return initialization;
  }
}
