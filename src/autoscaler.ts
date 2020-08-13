import { JibriTracker, JibriState, JibriStatusState, JibriMetric } from './jibri_tracker';

import logger from './logger';
import CloudManager from './cloud_manager';
import { InstanceDetails } from './instance_status';
import InstanceGroupManager, { InstanceGroup, ScalingOptions } from './instance_group';

export interface AutoscaleProcessorOptions {
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
    instanceGroupManager: InstanceGroupManager;
}

export default class AutoscaleProcessor {
    private jibriTracker: JibriTracker;
    private instaceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;

    constructor(options: AutoscaleProcessorOptions) {
        this.jibriTracker = options.jibriTracker;
        this.cloudManager = options.cloudManager;
        this.instaceGroupManager = options.instanceGroupManager;

        this.processAutoscaling = this.processAutoscaling.bind(this);
        this.processAutoscalingByGroup = this.processAutoscalingByGroup.bind(this);
    }

    async processAutoscaling(): Promise<boolean> {
        logger.debug('Starting to process scaling activities');
        const instanceGroups: Array<InstanceGroup> = await this.instaceGroupManager.getAllInstanceGroups();
        await Promise.all(instanceGroups.map(this.processAutoscalingByGroup));
        logger.debug('Stopped to process scaling activities');
        return true;
    }

    async processAutoscalingByGroup(group: InstanceGroup): Promise<boolean> {
        const currentInventory = await this.jibriTracker.getCurrent(group.name);
        const count = currentInventory.length;

        const scalingAllowed = await this.jibriTracker.allowScaling(group.name);
        if (!scalingAllowed) {
            logger.info(`Wait before allowing another scaling activity for group ${group.name}`);
            return;
        } else {
            logger.info(`Evaluating scale computed metrics for group ${group.name}`);
        }

        const maxPeriodCount = Math.max(
            group.scalingOptions.jibriScaleUpPeriodsCount,
            group.scalingOptions.jibriScaleDownPeriodsCount,
        );
        const metricInventoryPerPeriod: Array<Array<JibriMetric>> = await this.jibriTracker.getMetricPeriods(
            group.name,
            maxPeriodCount,
            group.scalingOptions.jibriScalePeriod,
        );

        const availableJibrisPerPeriodForScaleUp: Array<number> = await this.jibriTracker.getAvailableMetricPerPeriod(
            metricInventoryPerPeriod,
            group.scalingOptions.jibriScaleUpPeriodsCount,
        );

        const availableJibrisPerPeriodForScaleDown: Array<number> = await this.jibriTracker.getAvailableMetricPerPeriod(
            metricInventoryPerPeriod,
            group.scalingOptions.jibriScaleDownPeriodsCount,
        );

        logger.info(`Available jibris for scale up decision`, { availableJibrisPerPeriodForScaleUp });
        logger.info('Available jibris for scale down decision', { availableJibrisPerPeriodForScaleDown });

        if (this.evalScaleUpConditionForAllPeriods(availableJibrisPerPeriodForScaleUp, count, group.scalingOptions)) {
            logger.info(`Group ${group.name} with ${count} instances should scale up`);

            let actualScaleUpQuantity = group.scalingOptions.jibriScaleUpQuantity;
            if (count + actualScaleUpQuantity > group.scalingOptions.jibriMaxDesired) {
                actualScaleUpQuantity = group.scalingOptions.jibriMaxDesired - count;
            }

            this.cloudManager.scaleUp(group, count, actualScaleUpQuantity);
            this.jibriTracker.setGracePeriod(group.name);
        } else if (
            this.evalScaleDownConditionForAllPeriods(availableJibrisPerPeriodForScaleDown, count, group.scalingOptions)
        ) {
            logger.info(`Group ${group.name} with ${count} instances should scale down.`);

            let actualScaleDownQuantity = group.scalingOptions.jibriScaleDownQuantity;
            if (count - actualScaleDownQuantity < group.scalingOptions.jibriMinDesired) {
                actualScaleDownQuantity = count - group.scalingOptions.jibriMinDesired;
            }

            const scaleDownInstances = await this.getAvailableJibris(actualScaleDownQuantity, currentInventory);

            this.cloudManager.scaleDown(group, scaleDownInstances);
            this.jibriTracker.setGracePeriod(group.name);
        } else {
            logger.info(`No scaling activity needed for group ${group} with ${count} instances.`);
        }

        return true;
    }

    async getAvailableJibris(size: number, states: Array<JibriState>): Promise<Array<InstanceDetails>> {
        return states
            .filter((response) => {
                if (response.status.busyStatus == JibriStatusState.Idle) {
                    return true;
                } else {
                    return false;
                }
            })
            .slice(0, size)
            .map((response) => {
                return {
                    instanceId: response.jibriId,
                    instanceType: 'jibri',
                    group: response.metadata.group,
                };
            });
    }

    evalScaleUpConditionForAllPeriods(
        availableJibrisByPeriod: Array<number>,
        count: number,
        scalingOptions: ScalingOptions,
    ): boolean {
        return availableJibrisByPeriod
            .map((availableForPeriod) => {
                return (
                    (count < scalingOptions.jibriMaxDesired &&
                        availableForPeriod < scalingOptions.jibriScaleUpThreshold) ||
                    count < scalingOptions.jibriMinDesired
                );
            })
            .reduce((previousValue, currentValue) => {
                return previousValue && currentValue;
            });
    }

    evalScaleDownConditionForAllPeriods(
        availableJibrisByPeriod: Array<number>,
        count: number,
        scalingOptions: ScalingOptions,
    ): boolean {
        return availableJibrisByPeriod
            .map((availableForPeriod) => {
                return (
                    count > scalingOptions.jibriMinDesired &&
                    availableForPeriod > scalingOptions.jibriScaleDownThreshold
                );
            })
            .reduce((previousValue, currentValue) => {
                return previousValue && currentValue;
            });
    }
}
