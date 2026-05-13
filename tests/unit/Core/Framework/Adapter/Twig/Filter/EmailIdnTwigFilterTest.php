<?php declare(strict_types=1);

namespace Shopware\Tests\Unit\Core\Framework\Adapter\Twig\Filter;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;
use Shopware\Core\Checkout\Customer\Service\EmailIdnConverter;
use Shopware\Core\Framework\Adapter\Twig\Filter\EmailIdnTwigFilter;
use Shopware\Core\Framework\Log\Package;

/**
 * @internal
 */
#[Package('checkout')]
#[CoversClass(EmailIdnTwigFilter::class)]
class EmailIdnTwigFilterTest extends TestCase
{
    public function testIdnFilter(): void
    {
        $filter = new EmailIdnTwigFilter();

        static::assertCount(2, $filter->getFilters());

        $decodeFilter = $filter->getFilters()[0];
        static::assertSame('decodeIdnEmail', $decodeFilter->getName());
        $decodeCallable = $decodeFilter->getCallable();
        static::assertIsCallable($decodeCallable);
        static::assertSame(EmailIdnConverter::decode('foo@xn--bcher-kva.de'), $decodeCallable('foo@xn--bcher-kva.de'));

        $encodeFilter = $filter->getFilters()[1];
        static::assertSame('encodeIdnEmail', $encodeFilter->getName());
        $encodeCallable = $encodeFilter->getCallable();
        static::assertIsCallable($encodeCallable);
        static::assertSame(EmailIdnConverter::encode('foo@bücher.de'), $encodeCallable('foo@bücher.de'));
    }
}
