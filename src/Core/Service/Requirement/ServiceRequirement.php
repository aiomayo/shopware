<?php declare(strict_types=1);

namespace Shopware\Core\Service\Requirement;

use Shopware\Core\Framework\Log\Package;

/**
 * @internal
 *
 * A requirement that controls whether a service can be installed and run.
 */
#[Package('framework')]
interface ServiceRequirement
{
    public static function getName(): string;

    public function isSatisfied(): bool;
}
