# MSP Webhook
A plugin to send data from SignalK to a webhook.

Sends the following SignalK data streams:

* position: "navigation.position",
* speed: "navigation.speedOverGround",
* heading: "navigation.headingTrue",
* log: "navigation.trip.log",
* depth: "environment.depth.belowTransducer",
* wTemp: "environment.water.temperature",
* windSpeed: "environment.wind.speedApparent",
* windDir: "environment.wind.angleApparent",
* pressure: "environment.pressure"

User selectable time frame for sending data, sends on the hour following the specified period e.g. if set at 10 minutes will be on the hour, ten-past and so on. 

Authentication token sent as a URL parameter to allow a basic security check on the website

For an example of processing the data online, in PHP you can use the following code:

        // Check if the request method is POST
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            // Retrieve the JSON payload from the request body
            $jsonPayload = file_get_contents('php://input');

            // Decode the JSON payload into an associative array
            $data = json_decode($jsonPayload, true);

            // Check if the 'Authorization' header is set and contains the correct authentication key
            $authKey = 'Your Authentication key here';
            if (!isset($_GET['auth_key']) || $_GET['auth_key'] !== $authKey) {
                http_response_code(401); // Unauthorized
                echo json_encode(array('error' => $_GET['auth_key']));
                exit;
            }

            // Ensure navigation.position exists and contains latitude and longitude
            if (isset($data['position']['value']['latitude']) && isset($data['position']['value']['longitude'])) {

                $latitude = filter_var($data['position']['value']['latitude'], FILTER_SANITIZE_SPECIAL_CHARS);
                $longitude = filter_var($data['position']['value']['longitude'], FILTER_SANITIZE_SPECIAL_CHARS);
                $speed = isset($data['speed']['value']) ? filter_var($data['speed']['value'], FILTER_SANITIZE_SPECIAL_CHARS) : null;

                // Check if heading is in radians and convert to degrees
                if (isset($data['heading']['value'])) {
                    $headingRadians = filter_var($data['heading']['value'], FILTER_SANITIZE_SPECIAL_CHARS);
                    $headingDegrees = $headingRadians * (180 / M_PI);  // Convert radians to degrees
                } else {
                    $headingDegrees = null;
                }

                $depth = isset($data['depth']['value']) ? filter_var($data['depth']['value'], FILTER_SANITIZE_SPECIAL_CHARS) : null;
                $windSpeed = isset($data['windSpeed']['value']) ? filter_var($data['windSpeed']['value'], FILTER_SANITIZE_SPECIAL_CHARS) : null;

                // Check if windDirection is in radians and convert to degrees
                if (isset($data['windDir']['value'])) {
                    $windDirRadians = filter_var($data['windDir']['value'], FILTER_SANITIZE_SPECIAL_CHARS);
                    $windDirDegrees = $windDirRadians * (180 / M_PI);  // Convert radians to degrees
                } else {
                    $windDirDegrees = null;
                }

                $pressure = isset($data['pressure']) ? filter_var($data['pressure'], FILTER_SANITIZE_SPECIAL_CHARS) : null;
                $dateTime = isset($data['datetime']) ? filter_var($data['datetime'], FILTER_SANITIZE_SPECIAL_CHARS) : date('Y-m-d H:i:s');

                $responseData = [
                    'timeStamp'     => $dateTime,
                    'latitude'      => $latitude,
                    'longitude'     => $longitude,
                    'heading'       => $headingDegrees,
                    'depth'         => $depth,
                    'speed'         => $speed,
                    'windSpeed'     => $windSpeed,
                    'windDirection' => $windDirDegrees,
                    'temp'          => '',
                    'barometer'     => $pressure,
                ];

                // Add your processing here, you can use the array above to send onto a database query or something similar.
            }            

            http_response_code(200); // OK
            echo json_encode(array('message' => 'Data processed successfully', 'message' => 'Webhook received and processed'));
            exit();

        } else {

            // Respond with an error for unsupported request methods
            http_response_code(405); // Method Not Allowed
            echo json_encode(array('message' => 'Method Not Allowed'));
            exit();
            
        }





