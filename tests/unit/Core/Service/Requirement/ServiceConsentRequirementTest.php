<?php declare(strict_types=1);

namespace Shopware\Tests\Unit\Core\Service\Requirement;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;
use Shopware\Core\Service\LifecycleManager;
use Shopware\Core\Service\Permission\PermissionsService;
use Shopware\Core\Service\Requirement\ServiceConsentRequirement;
use Shopware\Core\Test\Stub\SystemConfigService\StaticSystemConfigService;

/**
 * @internal
 */
#[CoversClass(ServiceConsentRequirement::class)]
class ServiceConsentRequirementTest extends TestCase
{
    public function testGetName(): void
    {
        static::assertSame('service_consent', ServiceConsentRequirement::getName());
    }

    public function testIsSatisfiedWhenPermissionsAreGranted(): void
    {
        $permissionsService = $this->createMock(PermissionsService::class);
        $permissionsService->expects($this->once())
            ->method('areGranted')
            ->willReturn(true);

        $requirement = new ServiceConsentRequirement($permissionsService, new StaticSystemConfigService());

        static::assertTrue($requirement->isSatisfied());
    }

    public function testIsNotSatisfiedWhenPermissionsAreNotGranted(): void
    {
        $permissionsService = $this->createMock(PermissionsService::class);
        $permissionsService->expects($this->once())
            ->method('areGranted')
            ->willReturn(false);

        $requirement = new ServiceConsentRequirement($permissionsService, new StaticSystemConfigService());

        static::assertFalse($requirement->isSatisfied());
    }

    public function testIsInstallableWhenServicesAreEnabled(): void
    {
        $requirement = new ServiceConsentRequirement(
            $this->createMock(PermissionsService::class),
            new StaticSystemConfigService([LifecycleManager::CONFIG_KEY_SERVICES_DISABLED => false])
        );

        static::assertTrue($requirement->isInstallable());
    }

    public function testIsNotInstallableWhenServicesAreDisabled(): void
    {
        $requirement = new ServiceConsentRequirement(
            $this->createMock(PermissionsService::class),
            new StaticSystemConfigService([LifecycleManager::CONFIG_KEY_SERVICES_DISABLED => true])
        );

        static::assertFalse($requirement->isInstallable());
    }
}
