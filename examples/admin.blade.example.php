{{-- Example Blade view that hosts a Vue SPA + the frontend-conqueror overlay.

     Drop this snippet into the <head> of any Blade view where you want
     the overlay to activate.

     Two URL sources:
       - Dev: read from public/hot (written by laravel-vite-plugin when Vite is running)
       - Prod: read from env('FRONTEND_CONQUEROR_GATE_URL')

     If neither is set, no overlay loads — safe default. --}}

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>Your Admin</title>

    @vite('resources/admin/main.js')

    {{-- frontend-conqueror overlay (v0.5.0+ multi-project URL form) --}}
    @php
        $fcDevUrl     = file_exists(public_path('hot')) ? trim(file_get_contents(public_path('hot'))) : null;
        $fcGateUrl    = env('FRONTEND_CONQUEROR_GATE_URL');
        $fcProject    = env('FRONTEND_CONQUEROR_PROJECT', 'my-app');  // project key in gate admin
    @endphp
    @if(app()->environment('local') && $fcDevUrl)
        <script src="{{ $fcDevUrl }}/__frontend-conqueror/overlay.js" defer></script>
    @elseif(!app()->environment('local') && $fcGateUrl)
        <script src="{{ $fcGateUrl }}/{{ $fcProject }}/overlay.js" defer></script>
    @endif
</head>
<body>
    <div id="admin-app"></div>
</body>
</html>