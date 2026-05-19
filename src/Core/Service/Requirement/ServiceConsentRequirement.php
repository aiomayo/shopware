<?php declare(strict_types=1);

namespace Shopware\Core\Service\Requirement;

use Shopware\Core\Framework\Log\Package;
use Shopware\Core\Service\LifecycleManager;
use Shopware\Core\Service\Permission\PermissionsService;
use Shopware\Core\System\SystemConfig\SystemConfigService;

/**
 * @internal
 */
#[Package('framework')]
class ServiceConsentRequirement implements ServiceRequirement
{
    public const NAME = 'service_consent';

    public function __construct(
        private readonly PermissionsService $permissionsService,
        private readonly SystemConfigService $systemConfigService,
    ) {
    }

    public static function getName(): string
    {
        return self::NAME;
    }

    public function isSatisfied(): bool
    {
        return $this->permissionsService->areGranted();
    }

    public function isInstallable(): bool
    {
        return !$this->systemConfigService->getBool(LifecycleManager::CONFIG_KEY_SERVICES_DISABLED);
    }
}
