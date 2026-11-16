package ru.vybiraem.vmeste;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Фоновая проверка новых событий по расписанию JobScheduler (без Firebase и сторонних библиотек). */
public class NotifyJobService extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        boolean silent = params.getExtras().getBoolean(Notifier.EXTRA_SILENT, false);
        Thread worker = new Thread(() -> {
            try {
                Notifier.check(getApplicationContext(), silent);
            } finally {
                jobFinished(params, false);
            }
        }, "notify-check");
        worker.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // Система прервала проверку (пропала сеть) — повторим в следующий раз
        return true;
    }
}
