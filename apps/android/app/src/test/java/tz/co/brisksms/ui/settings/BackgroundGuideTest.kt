package tz.co.brisksms.ui.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundGuideTest {

    @Test
    fun samsungGetsItsOwnSteps() {
        val guide = BackgroundGuide.forManufacturer("samsung")
        assertEquals("Samsung", guide.maker)
        assertTrue(guide.steps.any { it.contains("Never sleeping apps") })
    }

    @Test
    fun redmiAndPocoShareTheXiaomiSteps() {
        assertEquals("Xiaomi", BackgroundGuide.forManufacturer("Redmi").maker)
        assertEquals("Xiaomi", BackgroundGuide.forManufacturer("POCO").maker)
    }

    @Test
    fun transsionBrandsAreRecognisedByName() {
        assertEquals("Tecno", BackgroundGuide.forManufacturer("TECNO").maker)
        assertEquals("Infinix", BackgroundGuide.forManufacturer("Infinix").maker)
        assertEquals("Itel", BackgroundGuide.forManufacturer("itel").maker)
    }

    @Test
    fun anUnknownMakerGetsTheGenericStepsAndNeverAnEmptyList() {
        val guide = BackgroundGuide.forManufacturer("Google")
        assertEquals("your phone", guide.maker)
        assertTrue(guide.steps.isNotEmpty())
    }
}
