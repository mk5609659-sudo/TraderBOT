#include <opencv2/opencv.hpp>
#include <iostream>
#include <string>

static double computeSimilarity(const cv::Mat &a, const cv::Mat &b) {
    cv::Mat resizedA, resizedB;
    cv::resize(a, resizedA, cv::Size(16, 16));
    cv::resize(b, resizedB, cv::Size(16, 16));

    cv::Mat grayA, grayB;
    cv::cvtColor(resizedA, grayA, cv::COLOR_BGR2GRAY);
    cv::cvtColor(resizedB, grayB, cv::COLOR_BGR2GRAY);

    cv::Scalar meanA = cv::mean(grayA);
    cv::Scalar meanB = cv::mean(grayB);

    int same = 0;
    int total = grayA.rows * grayA.cols;

    for (int y = 0; y < grayA.rows; y++) {
        for (int x = 0; x < grayA.cols; x++) {
            int valueA = grayA.at<uchar>(y, x) > meanA[0];
            int valueB = grayB.at<uchar>(y, x) > meanB[0];
            if (valueA == valueB) same++;
        }
    }

    return 100.0 * same / total;
}

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "Usage: " << argv[0] << " <restricted-image> <candidate-image>\n";
        return 1;
    }

    std::string restrictedPath = argv[1];
    std::string targetPath = argv[2];

    cv::Mat restricted = cv::imread(restrictedPath);
    cv::Mat target = cv::imread(targetPath);

    if (restricted.empty() || target.empty()) {
        std::cerr << "Unable to read one of the files. Make sure both paths are valid images.\n";
        return 1;
    }

    double similarity = computeSimilarity(restricted, target);
    std::cout << "Similarity: " << similarity << "%\n";
    return 0;
}
