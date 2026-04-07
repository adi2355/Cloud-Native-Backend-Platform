import { LoggerService } from './logger.service';
import { UserConsumptionProfileRepository } from '../repositories/user-consumption-profile.repository';

export interface DriftCheckResult {
  driftDetected: boolean;
  cumulativeSum: number;
  threshold: number;
  sensitivity: number;
}

export class DriftDetectorService {
  private readonly threshold: number;
  private readonly sensitivity: number;

  constructor(
    private profileRepository: UserConsumptionProfileRepository,
    private logger: LoggerService,
    threshold: number = 3.0,
    sensitivity: number = 0.5,
  ) {
    this.threshold = threshold;
    this.sensitivity = sensitivity;
  }

  async checkDrift(params: {
    userId: string;
    historicalMean: number;
    currentCumSum: number;
    newObservation: number;
  }): Promise<DriftCheckResult> {
    const { userId, historicalMean, currentCumSum, newObservation } = params;

    const deviation = newObservation - historicalMean;
    const newCumSum = Math.max(0, currentCumSum + Math.abs(deviation) - this.sensitivity);
    const driftDetected = newCumSum > this.threshold;

    await this.profileRepository.update(userId, {
      driftCumulativeSum: driftDetected ? 0 : newCumSum,
      lastDriftCheck: new Date(),
    });

    if (driftDetected) {
      this.logger.warn('Consumption drift detected', {
        userId,
        newObservation,
        historicalMean,
        cumulativeSum: newCumSum,
        threshold: this.threshold,
      });
    }

    return {
      driftDetected,
      cumulativeSum: driftDetected ? 0 : newCumSum,
      threshold: this.threshold,
      sensitivity: this.sensitivity,
    };
  }
}
