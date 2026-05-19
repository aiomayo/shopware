<?php declare(strict_types=1);

namespace Shopware\Core\Service;

use Shopware\Core\Framework\App\Lifecycle\AbstractAppLifecycle;
use Shopware\Core\Framework\App\Privileges\Privileges;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\Log\Package;
use Shopware\Core\Service\DTO\Service;
use Shopware\Core\Service\Permission\PermissionsService;
use Shopware\Core\Service\Requirement\RequirementsValidator;
use Shopware\Core\Service\ServiceRegistry\Client;
use Shopware\Core\System\SystemConfig\SystemConfigService;

/**
 * This class coordinates the lifecycle of self-managed services (apps).
 *
 * ENABLE_SERVICES is the global switch for service installation and updates. The persisted disabled state
 * is modeled as a service requirement, so services whose requirements remain satisfied, such as
 * Shopware Account-only services, keep running.
 *
 * Installation and updates are gated by each service's requirements. Once installed, each service can have two states:
 * Started: The service is running. The underlying application backing the service has all the required permissions.
 * Stopped: The service is not running. The underlying application backing the service is in a Pending Permission state.
 *
 * @internal
 */
#[Package('framework')]
class LifecycleManager
{
    public const AUTO_ENABLED = 'auto';

    public const CONFIG_KEY_SERVICES_DISABLED = 'core.services.disabled';

    public function __construct(
        private readonly Privileges $privileges,
        private readonly SystemConfigService $systemConfigService,
        private readonly ServiceStorage $serviceStorage,
        private readonly AbstractAppLifecycle $appLifecycle,
        private readonly AllServiceInstaller $serviceInstaller,
        private readonly PermissionsService $permissionsService,
        private readonly Client $client,
        private readonly RequirementsValidator $requirementsValidator,
        private readonly string $enabled = 'true',
        private readonly string $appEnv = 'prod',
    ) {
    }

    /**
     * @return array<string> The newly installed services
     */
    public function install(Context $context): array
    {
        if (!$this->enabled()) {
            return [];
        }

        return $this->serviceInstaller->install($context);
    }

    public function sync(Context $context): void
    {
        $this->removeOrphanedServices($this->serviceStorage->findAll($context), $context);
    }

    public function syncState(string $serviceName, Context $context): void
    {
        $service = $this->serviceStorage->findByName($serviceName, $context);
        if ($service === null) {
            throw ServiceException::serviceNotInstalled($serviceName);
        }

        $this->syncPrivileges($service, $context);
    }

    public function syncPrivileges(Service $service, Context $context): void
    {
        if ($this->requirementsValidator->isSatisfied($service->requirements)) {
            $this->privileges->acceptAllForApps([$service->id], $context);
        } else {
            $this->privileges->revokeAllForApps([$service->id], $context);
        }
    }

    /**
     * Re-evaluate all services that list the given requirement.
     * Called when a requirement's state changes.
     */
    public function syncRequirement(string $requirementName, Context $context): void
    {
        foreach ($this->serviceStorage->findAll($context) as $service) {
            if (\in_array($requirementName, $service->requirements, true)) {
                $this->syncPrivileges($service, $context);
            }
        }
    }

    /**
     * This method clears the persisted disabled state and schedules the installation of services.
     */
    public function enable(): void
    {
        $this->systemConfigService->delete(self::CONFIG_KEY_SERVICES_DISABLED, null, true);

        $this->serviceInstaller->scheduleInstall();
    }

    /**
     * This method disables services that no longer satisfy their requirements.
     */
    public function disable(Context $context): void
    {
        $this->systemConfigService->set(self::CONFIG_KEY_SERVICES_DISABLED, true, null, true);

        foreach ($this->serviceStorage->findAll($context) as $service) {
            if ($this->requirementsValidator->isSatisfied($service->requirements)) {
                continue;
            }

            $this->appLifecycle->delete($service->name, ['id' => $service->id], $context);
        }

        $this->permissionsService->revoke($context);
    }

    public function enabled(): bool
    {
        if ($this->enabled === self::AUTO_ENABLED) {
            return $this->appEnv === 'prod';
        }

        return (bool) filter_var($this->enabled, \FILTER_VALIDATE_BOOLEAN);
    }

    /**
     * @param list<Service> $services
     */
    private function removeOrphanedServices(array $services, Context $context): void
    {
        $registryServices = $this->client->getAll();

        if ($registryServices === []) {
            // this is not safe to do if there are zero services.
            // it could be a transient error or a misconfiguration.
            return;
        }

        $registryServiceNames = [];
        foreach ($registryServices as $registryService) {
            $registryServiceNames[$registryService->name] = true;
        }

        foreach ($services as $service) {
            if (!isset($registryServiceNames[$service->name])) {
                $this->appLifecycle->delete($service->name, ['id' => $service->id], $context);
            }
        }
    }
}
