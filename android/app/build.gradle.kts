plugins {
    id("com.android.application")
}

android {
    namespace = "ru.vybiraem.vmeste"
    compileSdk = 36

    defaultConfig {
        applicationId = "ru.vybiraem.vmeste"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        // Адрес сайта можно подменить при сборке: ./gradlew assembleDebug -PsiteUrl=http://192.168.1.5:5500/
        val siteUrl = (findProperty("siteUrl") as String?) ?: "https://yaroslaz.github.io/markets-pars/"
        resValue("string", "site_url", siteUrl)
    }

    buildFeatures {
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    // JVM-тест разбиения ClientHello (Desync) и разбора DNS (DnsWire): ./gradlew testDebugUnitTest
    // (на Windows из пути с кириллицей процесс тестов не находит классы — запускать из пути латиницей, например через junction)
    testImplementation("junit:junit:4.13.2")
}
