<?php declare(strict_types=1);

namespace Shopware\Core\Service\Requirement;

use Shopware\Core\Framework\Log\Package;

/**
 * @internal
 */
#[Package('framework')]
class RequirementsValidator
{
    /**
     * @var array<string, ServiceRequirement>
     */
    private readonly array $requirements;

    /**
     * @param iterable<string, ServiceRequirement> $requirements
     */
    public function __construct(iterable $requirements)
    {
        $this->requirements = \iterator_to_array($requirements);
    }

    /**
     * Returns true only if all requirements for the given service are satisfied.
     *
     * Unknown requirements are treated as unsatisfied.
     *
     * @param list<string> $requirementNames
     */
    public function isSatisfied(array $requirementNames): bool
    {
        foreach ($requirementNames as $name) {
            if (!isset($this->requirements[$name])) {
                return false;
            }

            if (!$this->requirements[$name]->isSatisfied()) {
                return false;
            }
        }

        return true;
    }
}
