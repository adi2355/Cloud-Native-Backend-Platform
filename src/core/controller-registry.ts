/**
 * Controller Registry - Type-Safe Dependency Container
 * Manages initialization and registration of all controllers with strict typing
 * Ensures controllers are initialized AFTER database and services
 *
 *  MODERN DI PATTERN: Pure constructor injection
 * - No singleton getInstance() pattern
 * - Instantiated once in bootstrap.ts (composition root)
 * - Injected as dependency where needed
 */

import { LoggerService } from '../services/logger.service';
import {
  AnyController,
  ControllerRegistryMap,
} from './controller.types';
import { isValidController } from './type-guards';

export class ControllerRegistry {
  private controllers: ControllerRegistryMap = new Map();  //  Strong typing

  /**
   * Constructor with pure dependency injection
   * @param logger - LoggerService instance for structured logging
   */
  constructor(
    private logger: LoggerService,
  ) {
    if (!logger) {
      throw new Error('ControllerRegistry: LoggerService dependency is required');
    }
    // Constructor accepts dependencies explicitly
    // No internal service resolution needed
  }

  /**
   * Register a pre-instantiated controller with type safety
   */
  public registerController<T extends AnyController>(name: string, controllerInstance: T): void {
    if (!controllerInstance) {
      throw new Error(`Cannot register null/undefined controller: ${name}`);
    }

    if (!isValidController(controllerInstance)) {
      throw new Error(`Invalid controller instance for '${name}': must be a valid controller object`);
    }

    if (this.controllers.has(name)) {
      this.logger.warn(`Controller '${name}' already registered. Overwriting.`);
    }

    this.controllers.set(name, controllerInstance);
    this.logger.info(`Controller registered: ${name}`);
  }


  /**
   * Get controller by name with type safety
   */
  public getController<T extends AnyController = AnyController>(name: string): T {
    const controller = this.controllers.get(name) as T;
    if (!controller) {
      const availableControllers = Array.from(this.controllers.keys()).join(', ');
      throw new Error(`Controller '${name}' not found. Available: ${availableControllers}`);
    }

    return controller;
  }

  /**
   * Get all registered controllers with type safety
   */
  public getAllControllers(): ControllerRegistryMap {
    return new Map(this.controllers); // Return copy to prevent external mutation
  }

  /**
   * Check if controller exists
   */
  public hasController(name: string): boolean {
    return this.controllers.has(name);
  }

  /**
   * Get list of registered controller names
   */
  public getControllerNames(): string[] {
    return Array.from(this.controllers.keys());
  }

}