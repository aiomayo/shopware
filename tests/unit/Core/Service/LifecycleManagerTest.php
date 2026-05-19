<?php declare(strict_types=1);

namespace Shopware\Tests\Unit\Core\Service;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use Shopware\Core\Framework\App\AppCollection;
use Shopware\Core\Framework\App\AppEntity;
use Shopware\Core\Framework\App\Lifecycle\AppLifecycle;
use Shopware\Core\Framework\App\Privileges\Privileges;
use Shopware\Core\Framework\Context;
use Shopware\Core\Service\AllServiceInstaller;
use Shopware\Core\Service\LifecycleManager;
use Shopware\Core\Service\Permission\PermissionsService;
use Shopware\Core\Service\Requirement\RequirementsValidator;
use Shopware\Core\Service\Requirement\ServiceConsentRequirement;
use Shopware\Core\Service\Requirement\ServicesEnabledRequirement;
use Shopware\Core\Service\Requirement\ShopwareAccountRequirement;
use Shopware\Core\Service\ServiceException;
use Shopware\Core\Service\ServiceRegistry\Client;
use Shopware\Core\Service\ServiceRegistry\ServiceEntry;
use Shopware\Core\Service\ServiceStorage;
use Shopware\Core\System\SystemConfig\SystemConfigService;
use Shopware\Core\Test\Stub\DataAbstractionLayer\StaticEntityRepository;
use Shopware\Tests\Unit\Core\Framework\App\AppFixture;

/**
 * @internal
 */
#[CoversClass(LifecycleManager::class)]
class LifecycleManagerTest extends TestCase
{
    private Privileges&MockObject $privileges;

    private SystemConfigService&MockObject $systemConfigService;

    private readonly AppLifecycle&MockObject $appLifecycle;

    private AllServiceInstaller&MockObject $serviceInstaller;

    private PermissionsService&MockObject $permissionsService;

    private Client&MockObject $client;

    private RequirementsValidator&MockObject $requirementsValidator;

    private Context $context;

    protected function setUp(): void
    {
        $this->privileges = $this->createMock(Privileges::class);
        $this->systemConfigService = $this->createMock(SystemConfigService::class);
        $this->appLifecycle = $this->createMock(AppLifecycle::class);
        $this->serviceInstaller = $this->createMock(AllServiceInstaller::class);
        $this->permissionsService = $this->createMock(PermissionsService::class);
        $this->client = $this->createMock(Client::class);
        $this->requirementsValidator = $this->createMock(RequirementsValidator::class);
        $this->context = Context::createDefaultContext();
    }

    public function testInstallWhenEnabled(): void
    {
        $expectedServices = ['service1', 'service2'];

        $this->serviceInstaller->expects($this->once())
            ->method('install')
            ->with($this->context)
            ->willReturn($expectedServices);

        $manager = $this->createManager($this->createAppRepository());

        $result = $manager->install($this->context);

        static::assertSame($expectedServices, $result);
    }

    public function testInstallWhenDisabledByEnv(): void
    {
        $this->serviceInstaller->expects($this->never())
            ->method('install');

        $manager = $this->createManager($this->createAppRepository(), enabled: 'false');

        $result = $manager->install($this->context);

        static::assertSame([], $result);
    }

    public function testEnable(): void
    {
        $this->systemConfigService->expects($this->once())
            ->method('delete')
            ->with(LifecycleManager::CONFIG_KEY_SERVICES_DISABLED);

        $this->serviceInstaller->expects($this->once())
            ->method('scheduleInstall');

        $manager = $this->createManager($this->createAppRepository());

        $manager->enable();
    }

    public function testDisable(): void
    {
        $services = new AppCollection([
            $this->createServiceEntity('service1', 'SwagService1', [ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME]),
            $this->createServiceEntity('service2', 'SwagService2', [ShopwareAccountRequirement::NAME]),
            $this->createServiceEntity('service3', 'SwagService3', [ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME]),
        ]);

        /** @var array<string, string> $deletedServices */
        $deletedServices = [
            'SwagService1' => 'service1',
            'SwagService3' => 'service3',
        ];

        $this->requirementsValidator->expects($this->exactly(3))
            ->method('isSatisfied')
            ->willReturnCallback(static fn (array $requirements): bool => $requirements === [ShopwareAccountRequirement::NAME]);

        $this->appLifecycle->expects($this->exactly(2))
            ->method('delete')
            ->willReturnCallback(function (string $name, array $options, Context $context) use (&$deletedServices): void {
                static::assertArrayHasKey($name, $deletedServices);
                static::assertSame(['id' => $deletedServices[$name]], $options);
                static::assertSame($this->context, $context);

                unset($deletedServices[$name]);
            });

        $this->permissionsService->expects($this->once())
            ->method('revoke')
            ->with($this->context);

        $this->systemConfigService->expects($this->once())
            ->method('set')
            ->with(LifecycleManager::CONFIG_KEY_SERVICES_DISABLED, true);

        $manager = $this->createManager($this->createAppRepository($services));

        $manager->disable($this->context);

        static::assertSame([], $deletedServices);
    }

    public function testDisableWithNoServices(): void
    {
        $services = new AppCollection([]);

        $this->appLifecycle->expects($this->never())
            ->method('delete');

        $this->requirementsValidator->expects($this->never())
            ->method('isSatisfied');

        $this->permissionsService->expects($this->once())
            ->method('revoke')
            ->with($this->context);

        $this->systemConfigService->expects($this->once())
            ->method('set')
            ->with(LifecycleManager::CONFIG_KEY_SERVICES_DISABLED, true);

        $manager = $this->createManager($this->createAppRepository($services));

        $manager->disable($this->context);
    }

    public function testSyncStateServiceNotFound(): void
    {
        $manager = $this->createManager($this->createAppRepository());

        $this->expectExceptionObject(ServiceException::serviceNotInstalled('NonExistentService'));

        $manager->syncState('NonExistentService', $this->context);
    }

    public function testSyncStateGrantsWhenRequirementsMet(): void
    {
        $serviceName = 'TestService';
        $serviceId = 'service-id-123';

        $service = $this->createServiceEntity($serviceId, $serviceName, [ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME]);

        $services = new AppCollection([$service]);

        $this->requirementsValidator->expects($this->once())
            ->method('isSatisfied')
            ->with([ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME])
            ->willReturn(true);

        $this->privileges->expects($this->once())
            ->method('acceptAllForApps')
            ->with([$serviceId], $this->context);

        $this->privileges->expects($this->never())
            ->method('revokeAllForApps');

        $manager = $this->createManager($this->createAppRepository($services));

        $manager->syncState($serviceName, $this->context);
    }

    public function testSyncStateRevokesWhenRequirementsNotMet(): void
    {
        $serviceName = 'TestService';
        $serviceId = 'service-id-123';

        $service = $this->createServiceEntity($serviceId, $serviceName, [ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME]);

        $services = new AppCollection([$service]);

        $this->requirementsValidator->expects($this->once())
            ->method('isSatisfied')
            ->with([ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME])
            ->willReturn(false);

        $this->privileges->expects($this->never())
            ->method('acceptAllForApps');

        $this->privileges->expects($this->once())
            ->method('revokeAllForApps')
            ->with([$serviceId], $this->context);

        $manager = $this->createManager($this->createAppRepository($services));

        $manager->syncState($serviceName, $this->context);
    }

    public function testSyncRequirementReEvaluatesAffectedServices(): void
    {
        $app1 = $this->createServiceEntity('id-1', 'Service1', [ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME]);
        $app2 = $this->createServiceEntity('id-2', 'Service2', [ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME]);
        $services = new AppCollection([$app1, $app2]);

        $this->requirementsValidator->expects($this->exactly(2))
            ->method('isSatisfied')
            ->with([ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME])
            ->willReturnOnConsecutiveCalls(true, false);

        $this->privileges->expects($this->once())
            ->method('acceptAllForApps')
            ->with(['id-1'], $this->context);

        $this->privileges->expects($this->once())
            ->method('revokeAllForApps')
            ->with(['id-2'], $this->context);

        $manager = $this->createManager($this->createAppRepository($services));

        $manager->syncRequirement(ServiceConsentRequirement::NAME, $this->context);
    }

    public function testSyncRequirementDoesNothingWhenNoServicesAffected(): void
    {
        $services = new AppCollection([
            $this->createServiceEntity('id-1', 'Service1', [ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME]),
        ]);

        $this->requirementsValidator->expects($this->never())
            ->method('isSatisfied');

        $this->privileges->expects($this->never())
            ->method('acceptAllForApps');

        $this->privileges->expects($this->never())
            ->method('revokeAllForApps');

        $manager = $this->createManager($this->createAppRepository($services));

        $manager->syncRequirement(ShopwareAccountRequirement::NAME, $this->context);
    }

    public function testSync(): void
    {
        $services = new AppCollection([
            $this->createServiceEntity('service1', 'SwagService1'),
            $this->createServiceEntity('service2', 'SwagService2'),
            $this->createServiceEntity('service3', 'OrphanedService'),
        ]);

        $this->client = $this->createMock(Client::class);
        $this->client->expects($this->once())
            ->method('getAll')
            ->willReturn([
                new ServiceEntry('SwagService1', 'Swag Service 1', 'https:/example.com', '/app-endpoint'),
                new ServiceEntry('SwagService2', 'Swag Service 2', 'https://swag-service2.example.com', '/app-endpoint'),
            ]);

        $this->appLifecycle->expects($this->once())
            ->method('delete')
            ->with('OrphanedService', ['id' => 'service3'], $this->context);

        $manager = $this->createManager($this->createAppRepository($services));

        $manager->sync($this->context);
    }

    public function testEnabledWithAutoInProdEnvironment(): void
    {
        $manager = $this->createManager($this->createAppRepository(), enabled: LifecycleManager::AUTO_ENABLED, appEnv: 'prod');

        static::assertTrue($manager->enabled());
    }

    public function testEnabledWithAutoInNonProdEnvironment(): void
    {
        $manager = $this->createManager($this->createAppRepository(), enabled: LifecycleManager::AUTO_ENABLED, appEnv: 'dev');

        static::assertFalse($manager->enabled());
    }

    public function testEnabledWithExplicitEnvValues(): void
    {
        $enabledManager = $this->createManager($this->createAppRepository(), enabled: 'true');
        $disabledManager = $this->createManager($this->createAppRepository(), enabled: 'false');

        static::assertTrue($enabledManager->enabled());
        static::assertFalse($disabledManager->enabled());
    }

    public function testEnabledDoesNotReadDisabledSystemConfig(): void
    {
        $this->systemConfigService->expects($this->never())
            ->method('getBool');

        $manager = $this->createManager($this->createAppRepository(), enabled: 'true');

        static::assertTrue($manager->enabled());
    }

    /**
     * @param StaticEntityRepository<AppCollection> $repository
     */
    private function createManager(
        StaticEntityRepository $repository,
        string $enabled = 'true',
        string $appEnv = 'prod',
    ): LifecycleManager {
        return new LifecycleManager(
            $this->privileges,
            $this->systemConfigService,
            new ServiceStorage($repository),
            $this->appLifecycle,
            $this->serviceInstaller,
            $this->permissionsService,
            $this->client,
            $this->requirementsValidator,
            $enabled,
            $appEnv,
        );
    }

    /**
     * @return StaticEntityRepository<AppCollection>
     */
    private function createAppRepository(AppCollection $apps = new AppCollection()): StaticEntityRepository
    {
        /** @var StaticEntityRepository<AppCollection> $appRepository */
        $appRepository = new StaticEntityRepository([
            $apps,
        ]);

        return $appRepository;
    }

    /**
     * @param list<string> $requirements
     */
    private function createServiceEntity(string $id, string $name, array $requirements = [ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME]): AppEntity
    {
        return AppFixture::createAppEntity(name: $name, id: $id)->assign([
            'version' => '1.0.0',
            'aclRoleId' => 'acl-role-id-' . $id,
            'active' => true,
            'selfManaged' => true,
            'sourceConfig' => $this->createSourceConfig($requirements),
        ]);
    }

    /**
     * @param list<string> $requirements
     *
     * @return array<string, mixed>
     */
    private function createSourceConfig(array $requirements = [ServicesEnabledRequirement::NAME, ServiceConsentRequirement::NAME]): array
    {
        $sourceConfig = [
            'version' => '1.0.0',
            'hash' => 'a453f',
            'revision' => '1.0.0-a453f',
            'zip-url' => 'https://example.com/zip',
            'hash-algorithm' => 'sha256',
            'min-shop-supported-version' => '6.6.0.0',
            'requirements' => $requirements,
        ];

        return $sourceConfig;
    }
}
